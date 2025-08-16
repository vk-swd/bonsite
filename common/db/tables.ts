import { Offset, Transaction, TransactionResult, TransactionValidator } from "../event_types.js";
import * as sql from 'mssql'
import { consumerRole, statementCreatorRole } from "./auth.js";

export const schema = 'scm'
type MetadataSerialized = {
    metadata: string;
}

const [tc_id, tc_date, tc_amount, tc_uFrom, tc_uTo] = Object.keys(TransactionValidator.shape);
type TransactionStored = MetadataSerialized & Transaction;
type TransactionResultStored = MetadataSerialized & TransactionResult;

export type ColumnDescription = {
    name: string;
    type: string;
    references?: ColumnDescription
    extra?: string; // e.g. 'NOT NULL', 'PRIMARY KEY', etc.
    sqlType?: sql.ISqlType; // optional, used for type inference
    jsType?: string; // optional, used for type inference
}

// type ValueWithMeta = { name: string, type: string, extra?: string }
export type Transformed<T> = {
  [K in keyof T]: ColumnDescription
}
enum Procedures {
    INSERT = 'INSERT',
    INSERT_CONFLICT_AWARE = 'INSERT_CONFLICT_AWARE',
    UPDATE = 'UPDATE',
    INSERT_IF_NOT_EXISTS = 'INSERT_IF_NOT_EXISTS',
    UPSERT = 'UPSERT'
}
export type TableDescription<T> = {
    name: string;
    columns: Transformed<T>;
    permissions: {role: string, permissions: string[]}[]; // e.g. {user: 'consumer', role: 'consumer_role', permissions: 'SELECT, INSERT'}
    foreignKeys?: { column: string, references: string }[]; // e.g. { column: 'FromUserId', references: 'users(id)' }
    primaryKey?: string[];
    nonClusteredIndexes?: { name: string, columns: string[], include?: string[] }[]; // e.g. { name: 'idx_c_transactionsByUser', columns: ['UserId', 'Date'], include: ['StatementId'] }
    procedures?: Procedures[]; // e.g. { name: 'addTransactionRecord', columns: transactionColumns, tail: '...' }
}





export const usersTable: TableDescription<{id: "", name:""}> = {
    name: `${schema}.users`, columns: {
        id: { name: 'id', type: 'BIGINT', extra: 'PRIMARY KEY' }, //IDENTITY(1,1)
        name: { name: 'Name', type: 'NVARCHAR(100)', extra: 'NOT NULL' }
    }, permissions: [
        { role: consumerRole, permissions: ['SELECT', 'INSERT'] },
        { role: statementCreatorRole, permissions: ['SELECT'] }
    ],
    procedures: [ Procedures.INSERT_IF_NOT_EXISTS ],
}

export const transactionsTable: TableDescription<TransactionStored> = {
    name: `${schema}.transactions`, 
    columns: {
        id: { name: "id", type: 'BIGINT', extra: 'PRIMARY KEY' },
        dateTime: { name: "dateTime", type:'DATETIME', extra: 'NOT NULL' },
        amount: { name: "amount", type: 'DECIMAL(18,2)', extra: 'NOT NULL' },
        userIdFrom: { name: "userIdFrom", type: 'BIGINT', extra: 'NOT NULL' },
        userIdTo: { name: "userIdTo", type: 'BIGINT', extra: 'NOT NULL' },
        metadata: { name: "metadata", type: 'NVARCHAR(max)', extra: 'NOT NULL' }
    },
    permissions: [
        { role: consumerRole, permissions: ['SELECT', 'INSERT'] },
        { role: statementCreatorRole, permissions: ['SELECT'] }
    ],
    foreignKeys: [
        { column: tc_uFrom, references: `${usersTable.name}(${usersTable.columns.id.name})` },
        { column: tc_uTo, references: `${usersTable.name}(${usersTable.columns.id.name})` }
    ],
    procedures: [ Procedures.INSERT_CONFLICT_AWARE ],
}

export const transactionResultsTable: TableDescription<TransactionResultStored> ={
    name: `${schema}.transaction_results`, columns: {
        id: { name: "transactionID", type: 'BIGINT', extra: 'PRIMARY KEY' },
        dateTime: { name: "dateTime", type: 'DATETIME', extra: 'NOT NULL' },
        state: { name: "state", type: 'TINYINT', extra: 'NOT NULL' },
        metadata: { name: "metadata", type: 'NVARCHAR(max)', extra: 'NOT NULL' }
    }, permissions: [
        { role: consumerRole, permissions: ['SELECT', 'INSERT'] },
        { role: statementCreatorRole, permissions: ['SELECT'] }
    ],
    procedures: [ Procedures.INSERT_CONFLICT_AWARE ],
}


export const transactionsByUserTable: TableDescription<{idx:"", userId:"", date: "", transId: ""}> = {
    name: `${schema}.transactions_by_user`, columns: {
        idx: { name: 'idx', type: 'BIGINT', extra: 'identity(1,1) primary key' },
        userId: { name: 'UserId', type: 'BIGINT', extra: 'NOT NULL' },
        date: { name: 'Date', type: 'DATETIME', extra: 'NOT NULL' },
        transId: { name: "TransactionId", type: 'BIGINT', extra: 'NOT NULL' }
    }, permissions: [
        { role: consumerRole, permissions: ['SELECT', 'INSERT'] },
        { role: statementCreatorRole, permissions: ['SELECT'] }
    ],
    foreignKeys: [
        { column: 'UserId', references: `${usersTable.name}(${usersTable.columns.id.name})` },
        { column: tc_id, references: 
            `${transactionsTable.name}(${tc_id})` }
    ],
    nonClusteredIndexes: [
        {
            name: 'idx_c_transactionsByUser',
            columns: ['UserId', 'Date'],
            include: ["TransactionId"]
        }
    ]
}

export const kafkaOffsetTable: TableDescription<Offset> = {
    name: `${schema}.kafka_offsets`, columns: {
        groupId: { name: 'groupId', type: 'NVARCHAR(18)', extra: 'NOT NULL' },
        topic: { name: 'topic', type: 'NVARCHAR(100)', extra: 'NOT NULL' },
        partition: { name: 'partition', type: 'INT', extra: 'NOT NULL' },
        offset: { name: 'offset', type: 'NVARCHAR(18)', extra: 'NOT NULL' }
    }, permissions: [
        { role: consumerRole, permissions: ['SELECT', 'INSERT', 'UPDATE'] }
    ],
    primaryKey: ['groupId', 'topic', 'partition']
}

export const rawDataTable: TableDescription<{idx: "", data: ""}> = {
    name: `${schema}.raw_data`, columns: {
        idx: { name: 'idx', type: 'BIGINT', extra: 'identity(1,1) primary key' },
        data: { name: 'data', type: 'NVARCHAR(max)', extra: 'NOT NULL' }
    }, permissions: [
        { role: consumerRole, permissions: ['INSERT', `SELECT`] }
    ],
    nonClusteredIndexes: [
        {
            name: `reverse_order_idx`,
            columns: ['idx DESC']
        }
    ]
}
