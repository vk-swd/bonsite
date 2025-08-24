import { InKafkaMessage, Metadata, MetadataValidator, Offset, OffsetValidator, StatementParameters, Transaction, TransactionMessages, TransactionResult, TransactionValidator, TResult } from '../event_types.js'

import sql from 'mssql'
import { logger } from '../logger.js'
import { Column, kafkaOffsetTable, parseQueryRes, QueryRecordSet, rawDataTable, TableDescription, transactionResultsTable, TransactionResultStored, transactionsTable, TransactionStored } from './tables.js'
import { connectToDatabase, database } from './common.js'
import { addKafkaOffsetProcedure, getRawDataRecordsProc, procGetTransactions, QueryRes, setUpTempTransactionResultsTable, setUpTempTransactionsTable } from './procedures.js'
import { consumerUser } from './auth.js'

function setQueryInput<T, K extends keyof T>(request: sql.Request, column: Column<T, K>, value: T, arg?: string): void {
    request.input(arg ? arg : column.inputName!, column.type.type, column.value(value));
}
export class Offsets {
    static create(queryResult: sql.IResult<any>): Offsets {
        try {
            const mapping = new Map<string, string>();
            queryResult.recordset.forEach(q => {
                const offset = OffsetValidator.parse(q)
                mapping.set(Offsets.key(offset.groupId, offset.topic, offset.partition), offset.offset);
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
    static key(groupId: string, topic: string, partition: number = 0): string {
        return `${groupId}-${topic}-${partition}`;
    }
    private constructor(private mapping: Map<string, string>) {
    }
    getOffset(group: string, topic: string, partition: number = 0): string | undefined {
        return this.mapping.get(Offsets.key(group, topic, partition));
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
    constructor(public pool: sql.ConnectionPool) {
    }
    isConnectionAlive(): boolean {
        return this.pool.connected;
    }
    pidx = 0;
    async writeDataTransactionally(
        records: InKafkaMessage[],
        writer: (record: InKafkaMessage[], request: sql.Request) => Promise<QueryRes>,
        oInfo: Offset
    ) {
        const batchInfo = () => `${oInfo.groupId}-${oInfo.topic}-${oInfo.partition}-${oInfo.offset}`;
        const transaction = new sql.Transaction(this.pool);
        try {
            await transaction.begin();
        } catch (e) {
            throw `Failed to start transaction for ${batchInfo()}: ${e}`;
        }
        let request = transaction.request();
        let result = new QueryRes();
        /*  Making long non-atomic transactions is prone to race conditions, when multiple agents
            are updating the same data.
            Here it is assumed that Kafka partitions are sharded by user ID (or another unique key). 
            This guarantees no key overlap, enabling safe parallel writes.
            No locking is used.
            And this assumption is enforced by Kafka, because only one consumer may
            read from a single partition at a time.
        */
        try {
            await writer(records, request)
            await this.commitOffset(oInfo, request);
            await transaction.commit();
            return result;
        } catch (e) {
            logger.error(`Failed to commit ${batchInfo()}: ${e}`);
        }
        try {
            await transaction.rollback();
            result.rolledBack = true;
        } catch (e) {
            throw `Failed to rollback ${batchInfo()}: ${e}`
        }
        return result;
    }
    async writeRawMessages(records: string[], oInfo: Offset): Promise<QueryRes> {
        const transaction = new sql.Transaction(this.pool);
        await transaction.begin();
        let request = transaction.request();
        for (const r of records) {
            await this.saveRawData(r, request);
        }
        await this.commitOffset(oInfo, request);
        await transaction.commit();
        // Not handling rollback, because raw table is a critical fallback storage
        // and failure to write to it means something is very wrong
        return { duds: records.length, rolledBack: false, newCount: 0 };
    }
    async sendTransactions(records: InKafkaMessage[], request: sql.Request): Promise<QueryRes> {
        await setUpTempTransactionsTable.batch(request);
        for (const r of records) {
            await this.addTransactionRecord(
                {...r.payload, metadata: JSON.stringify(r.metadata)} as TransactionStored, request);
        }
        const result = await setUpTempTransactionsTable.getCommitProcedure().batch(request);
        await setUpTempTransactionsTable.dropTable(request);
        return result;
    }
    async sendTransactionResults(records: InKafkaMessage[], request: sql.Request): Promise<QueryRes> {
        await setUpTempTransactionResultsTable.batch(request);
        for (const r of records) {
            await this.addTransactionResult(
                {...r.payload, metadata: JSON.stringify(r.metadata)} as TransactionResultStored, request);
        }
        const result = await setUpTempTransactionResultsTable.getCommitProcedure().batch(request);
        await setUpTempTransactionResultsTable.dropTable(request);
        return result;
    }
    
    async addTransactionRecord(record: TransactionStored, request: sql.Request): Promise<void> {
        let quer
        try {
            const proc = setUpTempTransactionsTable.getInsertionProcedure();
            const columns = proc.columns!;
            const placeholders = columns.map(() => `p${this.pidx++}`);
            columns.forEach((c, idx) => setQueryInput(request, c, record, placeholders[idx]))
            quer = `exec ${proc.name} ${
                columns.map((c, i) => `${c.parameterName} = @${placeholders[i]}`).join(', ')}`
            await request.batch(quer)
        } catch (e) {
            throw `Failed to add transaction record ${JSON.stringify(record)} query ${quer}: ${e}`
        }
    }
    async addTransactionResult(record: TransactionResultStored, request: sql.Request): Promise<void> {
        let quer
        try {
            const columns = (Object.values(transactionResultsTable.columns).slice(1));
            const placeholders = columns.map(() => `p${this.pidx++}`);
            columns.forEach((c, idx) => setQueryInput(request, c, record, placeholders[idx]))  
            quer = `exec ${setUpTempTransactionResultsTable.getInsertionProcedure().name} ${
                columns.map((c, i) => `${c.parameterName} = @${placeholders[i]}`).join(', ')}`
            await request.batch(quer)
        } catch (e) {
            throw `Failed to add transaction result record ${JSON.stringify(record)} query ${quer}: ${e}`
        }
    }
    async commitOffset(info: Offset, request: sql.Request): Promise<void> {
        const columns = (Object.values(kafkaOffsetTable.columns));
        const placeholders = columns.map((_, i) => `commitOffset${this.pidx++}`);
        columns.forEach((c, idx) => setQueryInput(request, c, info, placeholders[idx])) 
        await request!.batch(`exec ${addKafkaOffsetProcedure.name} ${columns
            .map((c, i) => `${c.parameterName} = @${placeholders[i]}`).join(', ')};`); 
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
        return Offsets.create(result);
    }
    async saveRawData(data: string, request: sql.Request): Promise<void> {
        const placeholder = `p${this.pidx++}`;
        request.input(placeholder, sql.NVarChar(sql.MAX), data);
        await request.batch(`INSERT INTO ${rawDataTable.name} 
            (${rawDataTable.columns.data.name})
            VALUES (@${placeholder});`);
    }
    async getTransactions(p: StatementParameters): Promise<InKafkaMessage[]> {
        const request = this.pool.request();
        try {
            procGetTransactions.columns!.forEach(c => setQueryInput(request, c, p));
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
    async streamSelectTransactions(p: StatementParameters, 
            processor: (transaction: string) => Promise<void>,
            completioner: () => Promise<void>): Promise<void> {
        const request = this.pool.request();
        request.stream = true; // Enable streaming
  
        procGetTransactions.columns!.forEach(c => setQueryInput(request, c, p));

        request.on('row', async (row: any) => {
            try {
                await processor(JSON.stringify(row));
            } catch (e) {
                logger.error(`Error processing row ${JSON.stringify(row)} for user ${p.userId}: ${e}`);
                request.cancel();
            }
        });
        let orderChecker = 0;  
        request.on('done', async (result: any) => {
            logger.debug(`${orderChecker++}: Stream done for ${JSON.stringify(p)}: ${JSON.stringify(result)}`);
            await completioner()
        });
        try {
            await request.execute(procGetTransactions.name);
            logger.debug(`${orderChecker++}: Stream execute completed for ${JSON.stringify(p)}`);
        } catch (e) {
            logger.error(`Error streaming transactions for ${JSON.stringify(p)}: ${e}`);
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
function transaction(row: QueryRecordSet<TransactionStored>) {
    return TransactionValidator.parse(parseQueryRes(row, transactionsTable.columns))
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



