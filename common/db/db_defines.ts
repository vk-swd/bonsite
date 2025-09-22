import { InKafkaMessage, Metadata, MetadataValidator, MetadataWrapperValidator, Offset, OffsetValidator, ServerState, ServerStateValidator, StatementParameters, Transaction, TransactionResultValidator, TransactionValidator, UserData, UserDataRequestParameters, UserDataResult, UserDataResultValidator, UserDataValidator } from '../event_types.js'

import sql from 'mssql'
import { logger } from '../logger.js'
import { Column, IdentityColumn, kafkaOffsetTable, parseQueryRes, rawDataTable, rawTableNames, RawTables, TableDescription, transactionResultsTable, TransactionResultStored, transactionsTable, TransactionStored, usersTable } from './tables.js'
import { connectToDatabase, database, runQuery } from './common.js'
import { addKafkaOffsetProcedure, CommitResults, CommitResultsC, getDBStatProc, getUsersProc, getUsersTopProc, procGetTransactions, QueryRes, SetUpTempTableProc, StatmentParamTable, UsersRequestC } from './procedures.js'
import { Deferred } from '../utils.js'

function setQueryInput<T, K extends keyof T>(request: sql.Request,
    column: Column<T, K>, value: T, arg?: string): void {
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
    static async create(login: string): Promise<UserConnection> {
        const pool = await connectToDatabase(login, database);
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
    async getUsers(params: UserDataRequestParameters): Promise<UserDataResult> {
        const request = this.pool.request();
        Object.entries(params).forEach(c => setQueryInput(request, Object(UsersRequestC)[c[0]], params));
        let res;
        if (params.cursor === undefined) {
            res = await request.execute(getUsersTopProc.procName)
        } else {
            res = await request.execute(getUsersProc.procName);
        }
        if (!(res.recordsets instanceof Array) || res.recordsets.length < 2) {
            throw new Error(`getUsers returned invalid result: ${JSON.stringify(res.recordsets)}`);
        }
        return UserDataResultValidator.parse({
            slice: res.recordsets[0].map(r => {
                const parsed = parseQueryRes(r, usersTable.columns)
                return { cursor: parsed.idx, name: parsed.name, id: parsed.id };
            }),
            totalCount: res.recordsets[1][0].totalCount });
    }
    async saveRawData(data: string, request: sql.Request): Promise<void> {
        // TODO: bukt it too
        const placeholder = `p${this.pidx++}`;
        request.input(placeholder, sql.NVarChar(sql.MAX), data);
        await request.batch(`INSERT INTO ${rawDataTable.name}
            (${rawDataTable.columns.data.name})
            VALUES (@${placeholder});`);
    }
    async streamTransactions(p: StatementParameters[], processor: (user: number, reqId: number, line: InKafkaMessage) => Promise<void>): Promise<void> {
        const request = this.pool.request();
        try {
            await request.query(`DROP TABLE IF EXISTS ${StatmentParamTable.name}`);
            await request.batch(`create table ${StatmentParamTable.name} (
                ${procGetTransactions.columns
                    .map((c, idx) => `${c.name} ${c.type.name}`).join(', ')})`)
        } catch(e) {
            throw `Error creating statement parameter table ${JSON.stringify(p)}: ${e}`;
        }
        const table = new sql.Table(StatmentParamTable.name);
        const dataColumns = procGetTransactions.columns;
        try {
            dataColumns.forEach(c => table.columns.add(c.name, c.type.type()))
        } catch (e) {
            throw `Failed to make table for getTransactions ${JSON.stringify(p)}: ${e}`
        }
        try {
            for (let idx = 0; idx < p.length; idx++) {
                const record = {...p[idx], idx: idx};
                table.rows.add(...dataColumns.map(c => c.value(record)));
            }
            await request.bulk(table);
        } catch (e) {
            throw `Failed to add statement parameter record ${JSON.stringify(p)}: ${e}`
        }
        request.stream = true; // Enable streaming
        const deferred = new Deferred<void>();
        let inFlight = 0;
        let done = false;
        request.on('error', err => {
            logger.error(`Caught Error in streamTransactions for`, p, `:`, err);
        });
        request.on('row', async (row: any) => {
            const {pidx, pid, ...rest} = row;
            const {metadata, idx, ...parsed} = parseQueryRes(rest, transactionsTable.columns);
            const res = { payload: parsed, metadata: MetadataValidator.parse(JSON.parse(row.metadata)) } as InKafkaMessage;
            inFlight++;
            processor(Number.parseInt(pid),Number.parseInt(pidx), res)
            .catch(e => {
                request.cancel();
                deferred.reject(`Error processing transaction for user ${row.pid} : ${e}`);
            }).finally(() => {
                inFlight--
                if (inFlight == 0 && done) {
                    deferred.resolve();
                }
            });
        })
        try {
            await request.batch(`EXEC ${procGetTransactions.procName}`);
        } catch (e) {
            deferred.reject(`Error running getTransactions ${JSON.stringify(p)}: ${e}`);
        }
        done = true;
        if (inFlight == 0) {
            deferred.resolve();
        }
        return deferred.promise;
    }
    async getRawData(count: number, table: RawTables): Promise<any[]> {
        const request = this.pool.request();
        let query = "";
        try {
            const args = ["lastCount", "tNameArg"];
            request.input(args[0], sql.BigInt, count);
            query = `with topItems as (SELECT top (@${args[0]}) *
                                        FROM ${rawTableNames[table]}
                                        order by ${IdentityColumn.idx.name} DESC)
                        SELECT * from topItems
                                order by ${IdentityColumn.idx.name} ASC;`
            const result = await request.query(query);
            return result.recordset;
        } catch (e) {
            throw `Error getting raw data. Query: ${query}. Error: ${e}`;
        }
    }
    async streamTable(name: string, processor: (row: any, total: number) => void): Promise<void> {
        const count = (await runQuery(this.pool, `SELECT COUNT(*) as c FROM ${name}`)).recordset[0].c;
        const request = this.pool.request();
        request.stream = true; // Enable streaming
        request.on('row', (row : any) => processor(row, count))
        await request.query(`SELECT * FROM ${name}`);
    }
    async getDBState(): Promise<ServerState> {
        const request = this.pool.request();
        let res
        try {
            res = await request.execute(getDBStatProc.procName);
        } catch (e) {
            throw new Error(`getDBState failed: ${e}`);
        }
        if (!(res.recordsets instanceof Array) || res.recordsets.length < 3) {
            throw new Error(`getDBState returned invalid result: ${JSON.stringify(res.recordsets)}`);
        }
        try {
            const resFinal = ServerStateValidator.parse(res.recordsets[0][0]); // validate other fields
            if (res.recordsets[1].length > 0) {
                const lastTransactionPosted = TransactionValidator.parse(parseQueryRes(res.recordsets[1][0], transactionsTable.columns));
                resFinal.lastTransactionPosted = JSON.stringify(lastTransactionPosted);
            }
            if (res.recordsets[2].length > 0) {
                const lastTransactionResPosted = TransactionResultValidator.parse(parseQueryRes(res.recordsets[2][0], transactionResultsTable.columns));
                resFinal.lastTransactionRes = JSON.stringify(lastTransactionResPosted);
            }
            return resFinal;
        } catch (e) {
            throw new Error(`getDBState failed to parse results: ${e}`);
        }
    }
}



