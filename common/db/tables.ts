import { Offset, Transaction, TransactionResult } from "../event_types.js";
import sql from "mssql";
import { consumerRole, statementCreatorRole } from "./auth.js";
import { parse } from "path";
import { exit } from "process";

export const schema = 'scm'
type MetadataSerialized = {
    metadata: string;
}

export type TransactionStored = MetadataSerialized & Transaction & { idx: number };
export type TransactionResultStored = MetadataSerialized & TransactionResult & { idx: number };

type SqlType = { name: string, type: sql.ISqlType, defaultParse: (s: string) => any };


const sqlTypes = {
    bigInt:         { name: 'BIGINT',          type: { type: sql.BigInt }, defaultParse: (s: string) => Number.parseInt(s) },
    dateTime:       { name: 'DATETIME',        type: { type: sql.DateTime }, defaultParse: (s: string) => new Date(s) },
    decimal:        { name: 'DECIMAL(18,2)',   type: { type: sql.Decimal(18, 2).type }, defaultParse: (s: string) => Number.parseFloat(s) },
    nvarchar:       { name: 'NVARCHAR(100)',   type: { type: sql.NVarChar(100).type }, defaultParse: (s: string) => s },
    nvarcharSmall:  { name: 'NVARCHAR(18)',    type: { type: sql.NVarChar(18).type }, defaultParse: (s: string) => s },
    nvarcharBig:    { name: 'NVARCHAR(max)',   type: { type: sql.NVarChar(sql.MAX).type }, defaultParse: (s: string) => s },
    int:            { name: 'INT',             type: { type: sql.Int }, defaultParse: (s: string) => Number.parseInt(s) },
    tinyint:        { name: 'TINYINT',         type: { type: sql.TinyInt }, defaultParse: (s: string) => Number.parseInt(s) }
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
    name: string,
    type: SqlType, 
    value: (c: T) => T[K] | string, 
    parse: (s: string) => T[K],
    parameterName?: string, // optional, used to batch stored procedures
    inputName?: string,// optional, used to exec stored procedures
    extra?: string
};
export function makeCol<T, K extends keyof T>(nameA: K, type: SqlType, extra?: string, value: Column<T,K>["value"] = (c:T) => Object(c)[nameA], parse: Column<T,K>["parse"] = type.defaultParse): Column<T, K> {
    const name = nameA as string;
    return { name, type, extra, value, parse, parameterName: `@${name}`, inputName: name };
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


type UserData = {id: string, name: string};
export const usersTable: TableDescription<UserData> = {
    name: `${schema}.users`, 
    columns: { 
        id: makeCol("id", sqlTypes.bigInt), 
        name: makeCol("name", sqlTypes.nvarchar) 
    },
    permissions: [
        { role: consumerRole, permissions: ['SELECT', 'INSERT'] },
        { role: statementCreatorRole, permissions: ['SELECT'] }
    ]
}

export const transactionsTable: TableDescription<TransactionStored> = {
    name: `${schema}.transactions`, 
    columns: {
        idx: makeCol("idx", sqlTypes.bigInt, 'identity(1,1) primary key'),
        id: makeCol("id", sqlTypes.bigInt, 'UNIQUE', (c) => c.id.toString(), (s) => Number.parseInt(s)),
        userIdFrom: makeCol("userIdFrom", usersTable.columns.id.type),
        userIdTo: makeCol("userIdTo", usersTable.columns.id.type),
        amount: makeCol("amount", sqlTypes.decimal),
        dateTime: makeCol("dateTime", sqlTypes.dateTime, undefined, (c) => new Date(c.dateTime).toISOString(), (s) => new Date(s).getMilliseconds()),
        metadata: makeCol("metadata", sqlTypes.nvarcharBig)
    },
    permissions: [
        { role: consumerRole, permissions: ['SELECT', 'INSERT'] },
        { role: statementCreatorRole, permissions: ['SELECT'] }
    ]
}
transactionsTable.foreignKeys = [
    { column: transactionsTable.columns.userIdFrom.name, references: `${usersTable.name}(${usersTable.columns.id.name})` },
    { column: transactionsTable.columns.userIdTo.name, references: `${usersTable.name}(${usersTable.columns.id.name})` }
]

export const transactionResultsTable: TableDescription<TransactionResultStored> ={
    name: `${schema}.transaction_results`, 
    columns: {
        idx: makeCol('idx', sqlTypes.bigInt, 'identity(1,1) primary key'),
        id: makeCol('id', transactionsTable.columns.id.type, 'UNIQUE', (c) => c.id.toString(), (s) => Number.parseInt(s)),
        dateTime: makeCol('dateTime', sqlTypes.dateTime, 'NOT NULL', (c) => new Date(c.dateTime).toISOString(), parse => new Date(parse).getMilliseconds()),
        state: makeCol('state', sqlTypes.tinyint, 'NOT NULL'),
        metadata: makeCol('metadata', sqlTypes.nvarcharBig, 'NOT NULL')
    },    
    permissions: [
        { role: consumerRole, permissions: ['SELECT', 'INSERT'] },
        { role: statementCreatorRole, permissions: ['SELECT'] }
    ]
    // Don't add id foreign key to transactionsTable, as arrival order is not guaranteed
}

type TransactionByUser = {idx:"", userId:"", date: "", transId: ""};
export const transactionsByUserTable: TableDescription<TransactionByUser> = {
    name: `${schema}.transactions_by_user`, 
    columns: {
        idx: makeCol('idx', sqlTypes.bigInt, 'identity(1,1) primary key'),
        userId: makeCol('userId', usersTable.columns.id.type, 'NOT NULL'),
        date: makeCol('date', sqlTypes.dateTime, 'NOT NULL'),
        transId: makeCol('transId', transactionsTable.columns.id.type, 'NOT NULL')
    }
    , permissions: [
        { role: consumerRole, permissions: ['SELECT', 'INSERT'] },
        { role: statementCreatorRole, permissions: ['SELECT'] }
    ]
}
transactionsByUserTable.foreignKeys = [
    { column: transactionsByUserTable.columns.userId.name, references: `${usersTable.name}(${usersTable.columns.id.name})` },
    { column: transactionsByUserTable.columns.transId.name, references: `${transactionsTable.name}(${transactionsTable.columns.id.name})` }
]

transactionsByUserTable.nonClusteredIndexes = [
    {
        name: 'idx_c_transactionsByUser',
        columns: [transactionsByUserTable.columns.userId.name, transactionsByUserTable.columns.date.name],
        include: [transactionsByUserTable.columns.transId.name]
    }
]

export const kafkaOffsetTable: TableDescription<Offset> = {
    name: `${schema}.kafka_offsets`, 
    columns: {
        groupId: makeCol('groupId', sqlTypes.nvarcharSmall, 'NOT NULL'),
        topic: makeCol('topic', sqlTypes.nvarchar, 'NOT NULL'),
        partition: makeCol('partition', sqlTypes.int, 'NOT NULL'),
        offset: makeCol('offset', sqlTypes.bigInt, 'NOT NULL')
    }
    , permissions: [
        { role: consumerRole, permissions: ['SELECT', 'INSERT', 'UPDATE'] }
    ]
}
kafkaOffsetTable.primaryKey = [kafkaOffsetTable.columns.groupId.name, kafkaOffsetTable.columns.topic.name, kafkaOffsetTable.columns.partition.name];

type RawData = {idx: "", data: ""};
export const rawDataTable: TableDescription<RawData> = {
    name: `${schema}.raw_data`, 
    columns: {
        idx: makeCol('idx', sqlTypes.bigInt, 'identity(1,1) primary key'),
        data: makeCol('data', sqlTypes.nvarcharBig, 'NOT NULL')
    }
    , permissions: [
        { role: consumerRole, permissions: ['INSERT', `SELECT`] }
    ]
}
rawDataTable.nonClusteredIndexes = [
    {
        name: `reverse_order_idx`,
        columns: [rawDataTable.columns.idx.name + ' DESC']
    }
]

