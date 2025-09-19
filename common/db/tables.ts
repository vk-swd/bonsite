import { Offset, Transaction, TransactionResult } from "../event_types.js";
import sql, { Table } from "mssql";
import { sinkRole, statementCreatorRole } from "./auth.js";
import { parse } from "path";
import { exit } from "process";

export const schema = 'scm'
type MetadataSerialized = {
    metadata: string;
}

export type IdentityColumnT = { idx: number };
export type TransactionStored = MetadataSerialized & Transaction & IdentityColumnT;
export type TransactionResultStored = MetadataSerialized & TransactionResult & IdentityColumnT;

type SqlType<T> = { name: string, type: () => T, defaultParse: (s: string) => any };
function makeSqlType<T>(name: string, type: () => T, defaultParse: (s: string) => any): SqlType<T> {
    return { name, type, defaultParse };
}

export const sqlTypes = {
    bigInt:         makeSqlType('BIGINT',        () => sql.BigInt,            (s: string) => Number.parseInt(s)),
    dateTime:       makeSqlType('DATETIME2(3)',  () => sql.DateTime2(3),      (s: string) => new Date(s)),
    decimal:        makeSqlType('DECIMAL(18,2)', () => sql.Decimal(18, 2),    (s: string) => Number.parseFloat(s)),
    nvarchar:       makeSqlType('NVARCHAR(100)', () => sql.NVarChar(100),     (s: string) => s),
    nvarcharSmall:  makeSqlType('NVARCHAR(18)',  () => sql.NVarChar(18),      (s: string) => s),
    nvarcharBig:    makeSqlType('NVARCHAR(max)', () => sql.NVarChar(sql.MAX), (s: string) => s),
    int:            makeSqlType('INT',           () => sql.Int,               (s: string) => Number.parseInt(s)),
    tinyint:        makeSqlType('TINYINT',       () => sql.TinyInt,           (s: string) => Number.parseInt(s))
}

export const IdentityColumn: Columns<IdentityColumnT> = {
    idx: makeCol('idx', sqlTypes.bigInt, 'identity(1,1) primary key')
}
export type TableDescription<T> = {
    name: string;
    columns: Columns<T>;
    permissions: {role: string, permissions: string[]}[];
    foreignKeys?: { column: string, references: string }[];
    primaryKey?: string[];
    nonClusteredIndexes?: { name: string, columns: string[], include?: string[] }[];
}

// function getTP(t: string)
export type Column<T, K extends keyof T> = {
    name: K,
    type: SqlType<any>,
    value: (c: T) => T[K] | string, 
    parse: (s: string) => T[K],
    parameterName?: string, // optional, used to batch stored procedures
    inputName?: string,// optional, used to exec stored procedures
    extra?: string
};
export function makeCol<T, K extends keyof T, S>(nameA: K, type: SqlType<S>, extra?: string, value: Column<T,K>["value"] = (c:T) => Object(c)[nameA], parse: Column<T,K>["parse"] = type.defaultParse): Column<T, K> {
    const name = nameA as string;
    return { name: nameA, type, extra, value, parse, parameterName: `@${name}`, inputName: name };
}
export type Columns<T>= {
    [K in keyof T]: Column<T, K>;
}
export type QueryRecordSet<T> = {
    [K in keyof T]: string;
}
export function parseQueryRes<T>(data: QueryRecordSet<T>, validator: Columns<T>): T {
    const parsed: any = {};
    for (const k of Object.entries(data)) {
        parsed[k[0]] = Object(validator)[k[0]]?.parse(k[1]);
    }
    return parsed as T;
}
export const statTable: TableDescription<IdentityColumnT & { name: string, value: string}> = {
    name: `${schema}.stats`,
    columns: {
        idx: makeCol('idx', sqlTypes.bigInt, 'identity(1,1) primary key'),
        name: makeCol('name', sqlTypes.nvarchar),
        value: makeCol('value', sqlTypes.nvarchar)
    },
    permissions: [
        { role: sinkRole, permissions: ['SELECT', 'INSERT', 'UPDATE'] }
    ]
}

type UserData = {id: number, name: string};
export const usersTable: TableDescription<UserData & IdentityColumnT> = {
    name: `${schema}.users`, 
    columns: {
        idx: makeCol("idx", IdentityColumn.idx.type, IdentityColumn.idx.extra),
        id: makeCol("id", sqlTypes.bigInt), 
        name: makeCol("name", sqlTypes.nvarchar) 
    },
    permissions: [
        { role: sinkRole, permissions: ['SELECT', 'INSERT'] },
        { role: statementCreatorRole, permissions: ['SELECT'] }
    ]
}

export const transactionsTable: TableDescription<TransactionStored> = {
    name: `${schema}.transactions`, 
    columns: {
        idx: makeCol("idx", IdentityColumn.idx.type, IdentityColumn.idx.extra),
        id: makeCol("id", sqlTypes.bigInt, 'UNIQUE', (c) => c.id.toString(), (s) => Number.parseInt(s)),
        userIdFrom: makeCol("userIdFrom", usersTable.columns.id.type),
        userIdTo: makeCol("userIdTo", usersTable.columns.id.type),
        amount: makeCol("amount", sqlTypes.decimal),
        dateTime: makeCol("dateTime", sqlTypes.dateTime, undefined, (c) => new Date(c.dateTime).toISOString(), (s) => new Date(s).getTime()),
        metadata: makeCol("metadata", sqlTypes.nvarcharBig)
    },
    permissions: [
        { role: sinkRole, permissions: ['SELECT', 'INSERT'] },
        { role: statementCreatorRole, permissions: ['SELECT'] }
    ]
}
transactionsTable.foreignKeys = [
    { column: transactionsTable.columns.userIdFrom.name, references: `${usersTable.name}(${usersTable.columns.id.name})` },
    { column: transactionsTable.columns.userIdTo.name, references: `${usersTable.name}(${usersTable.columns.id.name})` }
]
transactionsTable.nonClusteredIndexes = [
    {
        name: 'idx_c_transactions_userIdFrom_dateTime',
        columns: [transactionsTable.columns.userIdFrom.name, transactionsTable.columns.dateTime.name]
    },
    {
        name: 'idx_c_transactions_userIdTo_dateTime',
        columns: [transactionsTable.columns.userIdTo.name, transactionsTable.columns.dateTime.name]
    },
    {
        name: 'idx_c_transactions_id',
        columns: [transactionsTable.columns.id.name]
    }
]
export const transactionResultsTable: TableDescription<TransactionResultStored> ={
    name: `${schema}.transaction_results`, 
    columns: {
        idx: makeCol("idx", IdentityColumn.idx.type, IdentityColumn.idx.extra),
        id: makeCol('id', transactionsTable.columns.id.type, 'UNIQUE', (c) => c.id.toString(), (s) => Number.parseInt(s)),
        dateTime: makeCol('dateTime', sqlTypes.dateTime, 'NOT NULL', (c) => new Date(c.dateTime).toISOString(), parse => new Date(parse).getTime()),
        state: makeCol('state', sqlTypes.tinyint, 'NOT NULL'),
        metadata: makeCol('metadata', sqlTypes.nvarcharBig)
    },    
    permissions: [
        { role: sinkRole, permissions: ['SELECT', 'INSERT'] },
        { role: statementCreatorRole, permissions: ['SELECT'] }
    ]
    // Don't add id foreign key to transactionsTable, as arrival order is not guaranteed
}
transactionResultsTable.nonClusteredIndexes = [
    {
        name: 'idx_c_transactionResults_state',
        columns: [transactionResultsTable.columns.state.name, transactionResultsTable.columns.dateTime.name],
        include: [transactionResultsTable.columns.id.name]
    },
    {
        name: 'idx_c_transactionResults_id',
        columns: [transactionResultsTable.columns.id.name, transactionResultsTable.columns.dateTime.name]
    }
]

function makeDumpTable<T extends TransactionStored | TransactionResultStored>(table: TableDescription<T>): TableDescription<T> {
    const name = table.name + '_dump';
    const columns: Columns<T> = {} as Columns<T>;
    for (const [k, v] of Object.entries(table.columns)) {
        const col = Object(table.columns)[k];
        columns[k as keyof T] = makeCol(col.name, col.type, k === 'idx' ? 'identity(1,1) primary key' : undefined);
    }
    return { name, columns, permissions: table.permissions };
}
export const transactionsDumpTable = makeDumpTable(transactionsTable);
export const transactionResultsDumpTable = makeDumpTable(transactionResultsTable);
export const kafkaOffsetTable: TableDescription<Offset> = {
    name: `${schema}.kafka_offsets`, 
    columns: {
        groupId: makeCol('groupId', sqlTypes.nvarcharSmall, 'NOT NULL'),
        topic: makeCol('topic', sqlTypes.nvarchar, 'NOT NULL'),
        partition: makeCol('partition', sqlTypes.int, 'NOT NULL'),
        offset: makeCol('offset', sqlTypes.bigInt, 'NOT NULL')
    }
    , permissions: [
        { role: sinkRole, permissions: ['SELECT', 'INSERT', 'UPDATE'] }
    ]
}
kafkaOffsetTable.primaryKey = [kafkaOffsetTable.columns.groupId.name, kafkaOffsetTable.columns.topic.name, kafkaOffsetTable.columns.partition.name];

type RawData = IdentityColumnT & { data: ""};
export const rawDataTable: TableDescription<RawData> = {
    name: `${schema}.raw_data`, 
    columns: {
        idx: makeCol("idx", IdentityColumn.idx.type, IdentityColumn.idx.extra),
        data: makeCol('data', sqlTypes.nvarcharBig, 'NOT NULL')
    }
    , permissions: [
        { role: sinkRole, permissions: ['INSERT', `SELECT`] }
    ]
}
rawDataTable.nonClusteredIndexes = [
    {
        name: `reverse_order_idx`,
        columns: [rawDataTable.columns.idx.name + ' DESC']
    }
]
export enum RawTables {
    transactions = 1,
    transaction_results = 2,
    raw = 3
}
export const rawTableNames = {
    [RawTables.transactions]: transactionsDumpTable.name,
    [RawTables.transaction_results]: transactionResultsDumpTable.name,
    [RawTables.raw]: rawDataTable.name
}

