import { InKafkaMessage, Metadata, MetadataValidator, Offset, OffsetValidator, StatementParameters, Transaction, TransactionMessages, TransactionResult, TransactionValidator, TResult } from '../event_types.js'
import { getEnv, KConsumerOffsetInfo, last } from '../utils.js'

import sql from 'mssql'
import { logger } from '../logger.js'
import { ColumnDescription, kafkaOffsetTable, rawDataTable, TableDescription, transactionResultsTable, transactionsTable } from './tables.js'
import { connectToDatabase, database } from './common.js'
import { addKafkaOffsetProcedure, commitRecordedTransacrionResultsProc, commitRecordedTransacrionsProc, fullColumnName, getRawDataRecordsProc, procGetTransactions, procParameterName, QueryRes, setUpTempTransactionResultsTable, setUpTempTransactionsTable } from './procedures.js'
import { consumerUser } from './auth.js'
import { log } from 'console'









const typeToSqlFactoryType = new Map<string, sql.ISqlType>([
    ['BIGINT', { type: sql.BigInt }],
    ['DATETIME', { type: sql.DateTime }],
    ['DECIMAL(18,2)', { type: sql.Decimal(18, 2) }],
    ['NVARCHAR(100)', { type: sql.NVarChar(100) }],
    ['TINYINT', { type: sql.TinyInt }]
]);


function columtEqArg(c: ColumnDescription) {
    return `${c.name} = @${c.name}`;
}

function setQueryInput<T>(request: sql.Request, column: ColumnDescription, value: T, arg?: string): void {
    request.input(arg ? arg : column.name, typeToSqlFactoryType.get(column.type)!, value);
}
export class Offsets {
    static create(queryResult: sql.IResult<any>): Offsets {
        try {
            const mapping = new Map<string, string>();
            queryResult.recordset.forEach(q => {
                console.log(`Processing offset query result: ${JSON.stringify(q)}`);
                const offset = OffsetValidator.parse(q)
                mapping.set(`${offset.topic}-${offset.partition}`, offset.offset);
            });
            return new Offsets(mapping);
        } catch (e) {
            logger.error(`Error creating Offsets from query result ${JSON.stringify(queryResult.recordset)}: ${e}`);
            throw e;
        }
    }
    static empty(): Offsets {
        return new Offsets(new Map<string, string>());
    }
    private constructor(private mapping: Map<string, string>) {
    }
    getOffset(topic: string, partition: number = 0): string | undefined {
        return this.mapping.get(`${topic}-${partition}`);
    }
}

export enum ConnectionErrorType {
    TRANSACRION_ERROR,
    QUERY_ERROR
}
export class ConnectionError extends Error {
    constructor(public message: string, 
                public type: ConnectionErrorType,
                public readonly badCounter: number = 0) {
        super(message);
    }
}

export class UserConnection {
    static async create(): Promise<UserConnection> {
        const pool = await connectToDatabase(consumerUser.login, database);
        return new UserConnection(pool);
    }
    private constructor(public pool: sql.ConnectionPool) {
    }
    isConnectionAlive(): boolean {
        return this.pool.connected;
    }
    pidx = 0;
    async writeTransactionAndOffsetTransactionally(
        record: TransactionMessages,
        groupId: string,
        offset: string,
        partition: number,
        topic: string
    ): Promise<QueryRes> {

        const transaction = new sql.Transaction(this.pool)
        let request1: sql.Request | undefined = undefined;
        try {
            request1 = await (await transaction.begin()).request();
        } catch (e) {
            const error = new ConnectionError(`Failed to start transaction: ${e}`, ConnectionErrorType.TRANSACRION_ERROR);
            logger.error(error.message);
            throw error;
        }
        let result = new QueryRes();
        let error: ConnectionError | undefined = undefined;
        try {
            /*  Making long non-atomic transactions is prone to race conditions, when multiple agents
                are updating the same data.
                Here it is assumed that Kafka partitions are sharded by user ID (or another unique key). 
                This guarantees no key overlap, enabling safe parallel writes.
                No locking is used.
                And this assumption is enforced by Kafka, because only one consumer may
                read from a single partition at a time.
            */
            if (record.type == "t") {
                await setUpTempTransactionsTable.batch(request1!);
                // const q = `create table ${setUpTempTransactionsTable.tableName} (iddx int identity(1,1) primary key, 
                    // ${(Object.values(transactionsTable.columns) as ColumnDescription[]).map(c => `${c.name} ${c.type}`).join(', ')})`
                // await request1!.batch(q);
                for (let i = 0; i < record.r.length; i++) {
                    const r = record.r[i];
                    await this.addTransactionRecord(r.payload as Transaction, JSON.stringify(r.metadata),  request1!);
                }
                result = await commitRecordedTransacrionsProc.batch(request1!);
                await setUpTempTransactionsTable.dropTable(request1!);
            } else if (record.type == "r") {
                await setUpTempTransactionResultsTable.batch(request1!);
                for (const rec of record.r) {
                    await this.addTransactionResult(rec.payload as TransactionResult, JSON.stringify(rec.metadata), request1);
                }
                result = await commitRecordedTransacrionResultsProc.batch(request1!);
                await setUpTempTransactionResultsTable.dropTable(request1!);
            } else if (record.type == "e") {
                for (const rec of record.r) {
                    await this.saveRawData(rec, request1!);
                }
                result.duds = record.r.length;
            }
            await this.commitOffset(groupId, offset, topic, partition, request1);
            await transaction.commit();
        } catch (e) {
            error = new ConnectionError(`Failed to commit transaction: ${e}`, ConnectionErrorType.QUERY_ERROR);
            logger.error(error.message);
        }
        if (error === undefined) {
            return result;
        }
        try {
            await transaction.rollback()
            result.rolledBack = true;
        } catch (e) {
            const rollbackError = `Failed to rollback transaction: ${e}`;
            error.message += `\n${rollbackError}`;
            error.type = ConnectionErrorType.TRANSACRION_ERROR;
            logger.error(rollbackError);
            throw error;
        }
        return result;
    }

    async addTransactionRecord(record: Transaction, metadata: string, request: sql.Request): Promise<void> {
        let quer
        try {
            const columns = (Object.values(transactionsTable.columns));
            const param = (columnIdx: number) => procParameterName(fullColumnName(transactionsTable.name, columns[columnIdx]));
        
            const placeholders = columns.map((_, i) => `p${this.pidx++}`);
            request.input(placeholders[0], sql.BigInt, record.id)
            request.input(placeholders[1], sql.DateTime, new Date(record.dateTime).toISOString())
            request.input(placeholders[2], sql.Decimal(18, 2), record.amount)
            request.input(placeholders[3], sql.BigInt, record.userIdFrom)
            request.input(placeholders[4], sql.BigInt, record.userIdTo)
            request.input(placeholders[5], sql.NVarChar(sql.MAX), metadata)
            quer = `exec ${setUpTempTransactionsTable.getInsertionProcedure().name} ${
                columns
            .map((_, i) => `${param(i)} = @${placeholders[i]}`).join(', ')}`
            await request.batch(quer)
        } catch (e) {
            throw `Failed to add transaction record ${JSON.stringify(record)} query ${quer}: ${e}`
        }
    }
    async addTransactionResult(record: TransactionResult, metadata: string, request: sql.Request): Promise<void> {
        const columns = (Object.values(transactionResultsTable.columns)  as ColumnDescription[]);
        const param = (columnIdx: number) => procParameterName(fullColumnName(transactionResultsTable.name, columns[columnIdx]));
        const placeholders = columns.map((c, i) => `${c.name}${this.pidx++}`);
        request.input(placeholders[0], sql.BigInt, record.id)
        request.input(placeholders[1], sql.DateTime, new Date(record.dateTime).toISOString())
        request.input(placeholders[2], sql.TinyInt, record.state)
        request.input(placeholders[3], sql.NVarChar(sql.MAX), metadata)
        
        await request.batch(`exec ${setUpTempTransactionResultsTable.getInsertionProcedure().name} ${
            columns
            .map((_, i) => `${param(i)} = @${placeholders[i]}`).join(', ')}`)
    }
    async commitOffset(groupId: string, offset: string, topic: string, partition: number, request: sql.Request): Promise<void> {
        const columns = (Object.values(kafkaOffsetTable.columns) as ColumnDescription[]);
        const param = (columnIdx: number) => procParameterName(fullColumnName(kafkaOffsetTable.name, columns[columnIdx]));
        const placeholders = columns.map((_, i) => `commitOffset${this.pidx++}`);
        request.input(placeholders[0], sql.BigInt, groupId)
        request.input(placeholders[1], sql.NVarChar(100), topic)
        request.input(placeholders[2], sql.Int, partition)
        request.input(placeholders[3], sql.NVarChar(18), offset)
        await request!.batch(`exec ${addKafkaOffsetProcedure.name} ${columns
            .map((_, i) => `${param(i)} = @${placeholders[i]}`).join(', ')};`);
    }
    async getOffsets(): Promise<Offsets> {
        const request = this.pool.request()      
        let result;
        try {
            result = await request.query(`SELECT * FROM ${kafkaOffsetTable.name}`);
        } catch (e) {
            logger.error(`Error getting offsets: ${e}`);
            throw e;
        }
        logger.debug(`got offsets: ${JSON.stringify(result)}`);
        return Offsets.create(result);
    }
    async saveRawData(data: string, request: sql.Request): Promise<void> {
        const placeholder = `p${this.pidx++}`;
        request.input(placeholder, sql.NVarChar(sql.MAX), data);
        await request.batch(`INSERT INTO ${rawDataTable.name} 
            (${rawDataTable.columns.data.name})
            VALUES (@${placeholder});`);
    }
    async runQuery(query: string): Promise<sql.IResult<any>> {
        const request = this.pool.request();
        try {
            return await request.query(query);
        } catch (e) {
            logger.error(`Error running query ${query}: ${e}`);
            throw e;
        }
    }
    async getTransactions(p: StatementParameters): Promise<InKafkaMessage[]> {
        const request = this.pool.request();
        try {
            setQueryInput(request, procGetTransactions.userId, p.userId);
            if (p.from !== undefined && p.to !== undefined) {
                setQueryInput(request, procGetTransactions.dateFrom, new Date(p.from).toISOString());
                setQueryInput(request, procGetTransactions.dateTo, new Date(p.to).toISOString());
            } else {
                setQueryInput(request, procGetTransactions.dateFrom, new Date(0).toISOString());
                setQueryInput(request, procGetTransactions.dateTo, new Date("9999-12-31T23:59:59.997Z").toISOString());
            }
            return await transactions(await request.execute(procGetTransactions.name));
        } catch (e) {
            logger.error(`Error getting transactions: ${e}`);
            throw e;
        }
    }
    async getRawData(count: number): Promise<string[]> {
        const request = this.pool.request();
        try {
            request.input(getRawDataRecordsProc.lastCountArg, sql.BigInt, count);
            const result = await request.execute(getRawDataRecordsProc.name);
            return result.recordset.map((r : any) => r.data);
        } catch (e) {
            logger.error(`Error getting raw data: ${e}`);
            throw e;
        }
    }
    async streamTransactions(processor: (metadata: Metadata, userId?: number) => void): Promise<void> {
        const tables:[TableDescription<any>, (row: any) => void][] = [
            [transactionsTable,(row: any) => processor(MetadataValidator.parse(JSON.parse(row.metadata)), row.userIdFrom)], 
            [transactionResultsTable, (row:any) => processor(MetadataValidator.parse(JSON.parse(row.metadata)), -1)],
            [rawDataTable, (row: any) => processor(MetadataValidator.parse(JSON.parse(JSON.parse(row.data).metadata)))]];
        for (const table of tables) {
            await new Promise<void>((resolve, reject) => {
                const request = this.pool.request();
                request.stream = true; // Enable streaming
                request.on('row', (row : any) => table[1](row))
                request.on('done', (row : any) => {
                    logger.debug(`Pausing stream: ${JSON.stringify(row)}`);
                    resolve();
                })
                request.query(`SELECT * FROM ${table[0].name}`);
            })
        }
    }
    close(): Promise<void> {
        return this.pool.close();
    }
}
function transaction(row: any) {
    return TransactionValidator.parse({
        id: parseInt(row.id),
        amount: parseInt(row.amount), 
        dateTime: (new Date(row.dateTime).getMilliseconds()),
        userIdFrom: parseInt(row.userIdFrom),
        userIdTo: parseInt(row.userIdTo)
    });
 }
function transactions(sqlRes: sql.IResult<any>): InKafkaMessage[] {
    if (!sqlRes || !sqlRes.recordset || sqlRes.recordset.length === 0) {
        return [];
    }
    return sqlRes.recordset.map((r : any) => { return { 
            payload: transaction(r), metadata: MetadataValidator.parse(JSON.parse(r.metadata)) 
        } as InKafkaMessage;
    }) 
}
