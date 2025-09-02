import { InKafkaMessage, Metadata, MetadataValidator, Offset, OffsetValidator, StatementParameters } from '../event_types.js'

import sql from 'mssql'
import { logger } from '../logger.js'
import { Column, kafkaOffsetTable, parseQueryRes, rawDataTable, TableDescription, transactionResultsTable, TransactionResultStored, transactionsTable, TransactionStored } from './tables.js'
import { connectToDatabase, database, runQuery } from './common.js'
import { addKafkaOffsetProcedure, CommitResults, CommitResultsC, getRawDataRecordsProc, procGetTransactions, QueryRes, SetUpTempTableProc, StatmentParamTable } from './procedures.js'
import { consumerUser } from './auth.js'

function setQueryInput<T, K extends keyof T>(request: sql.Request, column: Column<T, K>, value: T, arg?: string): void {
    request.input(arg ? arg : column.inputName!, column.type.type(), column.value(value));
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
    async writeDataTransactionally<T extends TransactionResultStored | TransactionStored>(
        tempTable: SetUpTempTableProc<T>,
        records: InKafkaMessage[],
        oInfo: Offset
    ): Promise<CommitResults & {rolledBack: boolean}> {
        this.pidx = 0;
        const batchInfo = () => `${oInfo.groupId}-${oInfo.topic}-${oInfo.partition}-${oInfo.offset}`;
        const transaction = new sql.Transaction(this.pool);
        try {
            await transaction.begin();
        } catch (e) {
            throw `Failed to start transaction for ${batchInfo()}: ${e}`;
        }
        let request = transaction.request();
        /*  Making long non-atomic transactions is prone to race conditions, when multiple agents
            are updating the same data.
            Here it is assumed that Kafka partitions are sharded by user ID (or another unique key).
            This guarantees no key overlap, enabling safe parallel writes.
            No locking is used.
            And this assumption is enforced by Kafka, because only one consumer may
            read from a single partition at a time.
        */
        try {
            const result = await this.sendDataTransactionally(tempTable, records, request);
            // await this.getExecPlan(tempTable, request);
            await this.commitOffset(oInfo, request);
            await transaction.commit();
            return {...result, rolledBack: false};
        } catch (e) {
            logger.error(`Failed to commit ${tempTable.procName}-${batchInfo()}: ${e}`);
        }

        try {
            await transaction.rollback();
            return Object.values(CommitResultsC).reduce<CommitResults & {rolledBack: boolean}>((res, c) => ({...res, [c.name]: 0}), {rolledBack: false} as CommitResults & {rolledBack: boolean});
        } catch (e) {
            throw `Failed to rollback ${batchInfo()}: ${e}`
        }
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
    async sendDataTransactionally<T extends TransactionResultStored | TransactionStored>(tempTable: SetUpTempTableProc<T>, records: InKafkaMessage[], request: sql.Request) {
        await tempTable.dropTable(request);
        await tempTable.batch(request);
        const table = new sql.Table(tempTable.dstTable.name) // or temporary table, e.g. #temptable
        table.create = true
        const dataColumns = Object.values(tempTable.dstTable.columns).slice(1);
        dataColumns.map((c) => table.columns.add(c.name, c.type.type()));
        for (const record of records) {
            let quer
            try {
                const input = {...record.payload, metadata: JSON.stringify(record.metadata)}
                table.rows.add(...dataColumns.map(k => k.value(input)));
            } catch (e) {
                await tempTable.dropTable(request).catch((ee) => logger.error(`Error dropping temp table after failed insert: ${ee}`));
                throw `Failed to add transaction record ${JSON.stringify(record)} query ${quer}: ${e}`
            }
        }
        await request.bulk(table);
        const res = await tempTable.getCommitProcedure().batch(request);
        await tempTable.dropTable(request);
        return res;
    }

    async commitOffset(info: Offset, request: sql.Request): Promise<void> {
        const columns = (Object.values(kafkaOffsetTable.columns));
        const placeholders = columns.map((_, i) => `commitOffset${this.pidx++}`);
        columns.forEach((c, idx) => setQueryInput(request, c, info, placeholders[idx]))
        await request!.batch(`exec ${addKafkaOffsetProcedure.procName} ${columns
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
        // TODO: bukt it too
        const placeholder = `p${this.pidx++}`;
        request.input(placeholder, sql.NVarChar(sql.MAX), data);
        await request.batch(`INSERT INTO ${rawDataTable.name}
            (${rawDataTable.columns.data.name})
            VALUES (@${placeholder});`);
    }
    async getTransactions(p: StatementParameters[], processor: (user: number, line: InKafkaMessage) => Promise<void>): Promise<void> {
        const request = this.pool.request();
        await request.query(`DROP TABLE IF EXISTS ${StatmentParamTable.name}`);
        await request.batch(`create table ${StatmentParamTable.name} (
            ${procGetTransactions.columns
                .map((c, idx) => `${c.name} ${c.type.name} ${idx == 0 ? c.extra : ""}`).join(', ')})`)
        const table = new sql.Table(StatmentParamTable.name);
        const dataColumns = procGetTransactions.columns.slice(1); // skip idx
        try {
            dataColumns.forEach(c => table.columns.add(c.name, c.type.type()))
        } catch (e) {
            throw `Failed to make table for getTransactions ${JSON.stringify(p)}: ${e}`
        }
        try {
            for (const record of p) {
                table.rows.add(...dataColumns.map(c => c.value(record as StatementParameters & {idx: number})));
            }
            await request.bulk(table);
        } catch (e) {
            throw `Failed to add statement parameter record ${JSON.stringify(p)}: ${e}`
        }
        request.stream = true; // Enable streaming
        request.on('row', async (row: any) => {
            const parsed = parseQueryRes(row, transactionsTable.columns);
            const res = { payload: parsed, metadata: MetadataValidator.parse(JSON.parse(row.metadata)) } as InKafkaMessage;
            try {
                await processor(Number.parseInt(row.pid), res);
            } catch (e) {
                logger.error(`Error processing transaction for user ${row.pid} : ${e}`);
                request.cancel();
            }
        })
        try {
            await request.batch(`EXEC ${procGetTransactions.procName}`);
        } catch (e) {
            throw `Failed to getTransactions ${JSON.stringify(p)}: ${e}`
        }
    }
    async getRawData(count: number): Promise<string[]> {
        const request = this.pool.request();
        try {
            request.input(getRawDataRecordsProc.lastCountArg, sql.BigInt, count);
            const result = await request.execute(getRawDataRecordsProc.procName);
            return result.recordset.map((r : any) => r.data);
        } catch (e) {
            logger.error(`Error getting raw data: ${e}`);
            throw e;
        }
    }
    async streamTable(name: string, processor: (row: any, total: number) => void): Promise<void> {
        const count = (await runQuery(this.pool, `SELECT COUNT(*) as c FROM ${name}`)).recordset[0].c;
        const request = this.pool.request();
        request.stream = true; // Enable streaming
        request.on('row', (row : any) => processor(row, count))
        await request.query(`SELECT * FROM ${name}`);
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



