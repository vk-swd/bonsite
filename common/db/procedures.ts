import { MAX_DATE, MIN_DATE, ServerState, StatementParameters, TResult, UserDataRequestParameters, UserDateRange } from "../event_types.js";
import { commitTransactionQuery, getDBState, getTopUsersProcedureQuery, getUserDateRange, getUserProcedureQuery, getUserStatementsProcQuery, maybeRrotateRowsQuery, procedureQuery, recordUsersInTransactionsQuery } from "./queries.js";
import { Column, Columns, kafkaOffsetTable, makeCol, parseQueryRes, rawDataTable, schema, sqlTypes, statTable, statTableReads, Stringed, TableDescription, transactionResultsDumpTable, transactionResultsTable, TransactionResultStored, transactionsDumpTable, transactionsTable, TransactionStored, usersTable } from "./tables.js";
import sql from 'mssql'



interface SProc<T> {
    procName: string;
    columns?: Column<T, keyof T>[];
    getProcedureQuery(): string;
}


function makeProc<T>(procName: string, columns: Columns<T>, query: (name: string, ...args: any) => string, ...args: any): SProc<T> {
    const procQuery = query(procName, ...args);
    return {
        procName,
        columns: Object.values(columns),
        getProcedureQuery: () => procQuery
    };
}

export const UsersRequestC: Columns<UserDataRequestParameters> = {
    cursor: makeCol("cursor", usersTable.columns.idx.type),
    count: makeCol("count", sqlTypes.int),
    pattern: makeCol("pattern", sqlTypes.nvarchar)
};
export const getUsersProc = makeProc(`${schema}.getUsers`, UsersRequestC, getUserProcedureQuery);
export const getUsersTopProc = makeProc(`${schema}.getTopUsers`, UsersRequestC, getTopUsersProcedureQuery);

export const DBStateC: Columns<ServerState> = {
    transactionCount: makeCol("transactionCount", sqlTypes.bigInt),
    userCount: makeCol("userCount", sqlTypes.bigInt),
    cpuBisy: makeCol("cpuBisy", sqlTypes.bigInt),
    totalRead: makeCol("totalRead", sqlTypes.bigInt),
    totalWrite: makeCol("totalWrite", sqlTypes.bigInt),
    totalErrors: makeCol("totalErrors", sqlTypes.bigInt),
    maxUserId: makeCol("maxUserId", sqlTypes.bigInt),
    maxTransactionId: makeCol("maxTransactionId", sqlTypes.bigInt),
    maxTransactionResId: makeCol("maxTransactionResId", sqlTypes.bigInt),
    lastTransactionPosted: makeCol("lastTransactionPosted", sqlTypes.nvarcharBig, "null"),
    lastTransactionRes: makeCol("lastTransactionRes", sqlTypes.nvarcharBig, "null"),
}
export const getDBStatProc = makeProc(`${schema}.getDBStat`, DBStateC, getDBState);

export const UserDateRangeC: Columns<UserDateRange> = {
    userId: makeCol("userId", usersTable.columns.id.type),
    minDate: makeCol("minDate", sqlTypes.dateTime),
    maxDate: makeCol("maxDate", transactionsTable.columns.dateTime.type)
};
export const getUserDateRangeProc = makeProc(`${schema}.getUserDateRange`, UserDateRangeC, getUserDateRange);

type StatementReqParam = Omit<{ idx: number } & StatementParameters, "type"|"offset"|"count">;
export const StatmentParamTable: TableDescription<StatementReqParam> = {
    name: `#tempParamTable`,
    columns: {
        idx: makeCol("idx", sqlTypes.int, "identity(1,1) primary key"),
        userId: makeCol("userId", usersTable.columns.id.type),
        fromm: makeCol("fromm", transactionsTable.columns.dateTime.type, undefined, (c) => new Date(c.fromm ?? MIN_DATE).toISOString()),
        too: makeCol("too", transactionsTable.columns.dateTime.type, undefined, (c) => new Date(c.too ?? MAX_DATE).toISOString())
    },
    permissions: []
};
export const procGetTransactions = makeProc(`${schema}.getTransactions`, StatmentParamTable.columns, getUserStatementsProcQuery);


function fullColumnNamesEqItsProcArgs<T, K extends keyof T>(c: Column<T,K>[], sep: string = ', '): string {
    return c.map(col =>  `${col.inputName} = ${col.parameterName}`).join(sep);
}
function ifExistsQuery<T, K extends keyof T>(tableName: string, lookedUpColumns: Column<T,K>[]): string {
    return `EXISTS (SELECT 1
            FROM ${tableName}
            WHERE ${fullColumnNamesEqItsProcArgs(lookedUpColumns, ' AND ')})`;
}
function updateQuery<T, K extends keyof T>(tableName: string, updatedColumn: Column<T,K>[], lookedUpColumns: Column<T,K>[]): string {
    return `UPDATE ${tableName}
            SET  ${fullColumnNamesEqItsProcArgs(updatedColumn)}
            WHERE (${fullColumnNamesEqItsProcArgs(lookedUpColumns, ' AND ')})`
}
function columnsToValues<T, K extends keyof T>(columns: Column<T,K>[]): string {
    return columns.map(c => c.inputName).join(', ');
}
function insertQuery<T, K extends keyof T>(name: string, columns: Column<T,K>[]): string {
    return `INSERT INTO ${name} (${columnsToValues(columns)})
            VALUES (${columns.map(c => c.parameterName).join(',')});`
}
class AddKafkaOffsetProcedure implements SProc<{}> {
    public procName = `${schema}.addKafkaOffset`;
    getProcedureQuery(): string {
        return procedureQuery(this.procName, Object.values(kafkaOffsetTable.columns), `
                if ${ifExistsQuery(kafkaOffsetTable.name, Object.values(kafkaOffsetTable.columns).slice(0,-1))}
                    ${updateQuery(kafkaOffsetTable.name, [kafkaOffsetTable.columns.offset], Object.values(kafkaOffsetTable.columns).slice(0,-1))}
                else
                    ${insertQuery(kafkaOffsetTable.name, Object.values(kafkaOffsetTable.columns))}
            `)
    }
}
export const addKafkaOffsetProcedure = new AddKafkaOffsetProcedure();

//TODO: do something with this duplication and this inconvinient rolledBack boolean
export class QueryRes {
    duds: number = 0;
    newCount: number = 0;
    rolledBack?: boolean;
}
export const CommitResultsC: Columns<QueryRes> = {
    duds: makeCol("duds", sqlTypes.int),
    newCount: makeCol("newCount", sqlTypes.int)
};
export class SetUpTempTableProc<T extends TransactionResultStored | TransactionStored> implements SProc<T> {
    public procName: string
    public tableName: string
    public dstTable: TableDescription<T>
    private pr: SProc<{}>

    constructor(public srcTable: TableDescription<T>, private dumpTable: TableDescription<T>) {
        const tName = srcTable.name.replace(/\./g, '');
        this.tableName = `#${tName}`;
        // this.tableName = `${srcTable.name}temp`;
        this.procName = `${schema}.create${tName}`;
        this.dstTable = {...srcTable, name: this.tableName};
        this.pr = makeProc<{}>(`${schema}.CommitRecorded${tName}`, {}, 
            commitTransactionQuery, this.tableName, this.dumpTable.name, this.srcTable,
            this.srcTable.name == transactionsTable.name ? recordUsersInTransactionsQuery(this.tableName) : "");
    }
    getProcedureQuery(): string {
        return ""
    }
    async batch(request: sql.Request): Promise<void> {
        // Rely on the fact that original table has first column as identity primary key
        await request.batch(`create table ${this.dstTable.name} (
                    ${(Object.values(this.dstTable.columns))
                        .map((c, idx) => `${c.name} ${c.type.name} ${idx == 0 ? c.extra : ""}`).join(', ')})`)
    }
    async dropTable(request: sql.Request): Promise<void> {
        await request.batch(`DROP TABLE IF EXISTS ${this.dstTable.name}`);
    }
    getCommitProcedure(): SProc<{}> {
        return this.pr;
        // return new CommitTempRecordsProc(`${schema}.CommitRecorded${this.srcTable.name.replace(/\./g, '')}`, this.dstTable, this.srcTable);
    }
}
export const setUpTempTransactionsTable = new SetUpTempTableProc(transactionsTable, transactionsDumpTable);
export const setUpTempTransactionResultsTable = new SetUpTempTableProc(transactionResultsTable, transactionResultsDumpTable);

export const RotateTableArgs: Columns<{columns: number}> = {
    columns: makeCol("columns", sqlTypes.int),
};
export type RotateTableResult = {removed: number, usedSpaceBytes: number, usedSpaceBytesNew: number};
export const RotateTableResultC: Columns<RotateTableResult> = {
    removed: makeCol("removed", sqlTypes.bigInt),
    usedSpaceBytes: makeCol("usedSpaceBytes", sqlTypes.bigInt),
    usedSpaceBytesNew: makeCol("usedSpaceBytesNew", sqlTypes.bigInt)
};
export const RotateTableProc = makeProc(`${schema}.rotateTables`, RotateTableArgs, maybeRrotateRowsQuery);

