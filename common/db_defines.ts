import { connect } from 'http2'
import { Transaction, TransactionResult, TResult } from './event_types.js'
import { getEnv, last } from './utils.js'

import sql from 'mssql'


// const sql = require('mssql')

const user_sa = getEnv('MSSQL_SA_USERNAME')
const demo_password = getEnv('MSSQL_PASSWORD')
const database = getEnv('MSSQL_DB_NAME')
const server = getEnv('MSSQL_HOSTNAME')
const user_consumer = getEnv('MSSQL_CONSUMER_USERNAME')
const user_statement_creator = getEnv('MSSQL_STATEMENT_CREATOR_USERNAME')

const schema = 'scm'
const transactionsTable = `${schema}.transactions`
const usersTable = `${schema}.users`
const kafkaOffsetTable = `${schema}.kafka_offsets`
const transactionsByUserTable = `${schema}.transactions_by_user`

const consumerRole = `${user_consumer}_role`
const consumerUser = `${user_consumer}_user`
const consumerLogin = `${user_consumer}_login`

const statementUser = `${user_statement_creator}_user`
const statementCreatorRole = `${user_statement_creator}_role`
const statementCreatorLogin = `${user_statement_creator}_login`

function connectToDatabase(login: string, database?: string): Promise<sql.ConnectionPool> {
    return sql.connect({
        user: login,
        password: demo_password,
        server,
        database,
        options: { trustServerCertificate: true }
    });
}
function runQuery(pool: sql.ConnectionPool, query: string): Promise<sql.IResult<any>> {
    return pool.request().query(query).catch(e => {
        console.error(`Error running query: ${query}`, e);
        throw e;
    });
}
type ColumnDescription = {
    name: string;
    type: string;
    extra?: string; // e.g. 'NOT NULL', 'PRIMARY KEY', etc.
}
const transactionColumns: ColumnDescription[] = [
    { name: 'StatementId', type: 'BIGINT', extra: 'PRIMARY KEY' },
    { name: 'Date', type: 'DATETIME2(3)' },
    { name: 'Amount', type: 'DECIMAL(18,2)' },
    { name: 'FromUserId', type: 'BIGINT' },
    { name: 'ToUserId', type: 'BIGINT' },
    { name: 'Status', type: 'TINYINT' }
]
const userColumns: ColumnDescription[] = [
    { name: 'id', type: 'BIGINT IDENTITY(1,1)', extra: ' PRIMARY KEY' },
    { name: 'Name', type: 'NVARCHAR(100)', extra: ' NOT NULL' }
]
const transactionsByUserColumns: ColumnDescription[] = [
    { name: 'UserId', type: 'BIGINT', extra: ' NOT NULL' },
    { name: 'Date', type: 'DATETIME2(3)', extra: ' NOT NULL' },
    { name: 'StatementId', type: 'BIGINT' },
]
const kafkaOffsetColumns: ColumnDescription[] = [
    { name: 'Groupid', type: 'BIGINT' },
    { name: 'Topic', type: 'NVARCHAR(100)', extra: ' NOT NULL' },
    { name: 'Partition', type: 'INT', extra: ' NOT NULL' },
    { name: 'Offset', type: 'NVARCHAR(18)', extra: ' NOT NULL' }
]
function columnsToString(columns: ColumnDescription[]): string {
    return columns.map(c => `${c.name} ${c.type}${c.extra ? ' '+ c.extra : ''}`).join(',\n');
}
function columnsToProcedureTypes(columns: ColumnDescription[]): string {
    return columns.map(c => `@${c.name} ${c.type}`).join(',\n');
}
function columnsToProcedureInputs(columns: ColumnDescription[]): string {
    return columns.map(c => `@${c.name}`).join(', ');
}
function columnsToValues(columns: ColumnDescription[]): string {
    return columns.map(c => `${c.name}`).join(', ');
}
function insertionProcedureQuery(procedureName: string, tableName: string, columns: ColumnDescription[]): string {
    return `
        CREATE PROCEDURE ${procedureName}
        ${columnsToProcedureTypes(columns)}
        AS
        SET NOCOUNT ON;
        INSERT INTO ${tableName} (${columnsToValues(columns)})
        VALUES (${columnsToProcedureInputs(columns)})
    `;
}
const addTransactionProcedure = "addTransactionRecord";
const addUserProcedure = "addUser";
const updateTransactionStatusProcedure = "updateTransactionStatus";
const addTransactionByUserProcedure = "addTransactionByUser";
const addKafkaOffsetProcedure = "addKafkaOffset";
export async function createSchema() {
    const pool = await connectToDatabase(user_sa);
    await runQuery(pool, `create database [${database}]`)
    await runQuery(pool, `use ${database};`)
    await runQuery(pool, `create schema [${schema}]`)
    await runQuery(pool,
        `CREATE TABLE ${usersTable} (
            ${columnsToString(userColumns)}
        );`)

    await runQuery(pool,
        `CREATE TABLE ${transactionsTable} (
            ${columnsToString(transactionColumns)}
            FOREIGN KEY (${transactionColumns[3].name}) REFERENCES ${usersTable}(${userColumns[0].name}),
            FOREIGN KEY (${transactionColumns[4].name}) REFERENCES ${usersTable}(${userColumns[0].name})
        );`)

    await runQuery(pool,
        `CREATE TABLE ${transactionsByUserTable} ( 
            ${columnsToString(transactionsByUserColumns)}
            FOREIGN KEY (${transactionsByUserColumns[2].name}) REFERENCES ${transactionsTable}(${transactionColumns[0].name}),
            FOREIGN KEY (${transactionsByUserColumns[0].name}) REFERENCES ${usersTable}(${userColumns[0].name}) 
        );`)

    await runQuery(pool,
        // Make a (UserId, Date) INCLUDE (StatementId) nonclustered index on transactionsByUserTable
        `CREATE NONCLUSTERED INDEX idx_c_transactionsByUser ON ${transactionsByUserTable} (${transactionsByUserColumns.slice(0,-1)}) INCLUDE (${last(transactionsByUserColumns)!.name});`
    )
    await runQuery(pool,
        `CREATE TABLE ${kafkaOffsetTable} (
            ${columnsToString(kafkaOffsetColumns)}
            PRIMARY KEY (${kafkaOffsetColumns.slice(0, -1).map(c => c.name).join(', ')})
        );`)
    const make_user = async (user: string, password: string, role: string, login: string) => {
        await runQuery(pool,`CREATE LOGIN ${login} WITH PASSWORD = '${password}'`)
        await runQuery(pool,`CREATE ROLE ${role}`)
        await runQuery(pool,`CREATE USER ${user} for LOGIN ${login}`)
    }
    await make_user(consumerUser, demo_password, consumerRole, consumerLogin)
    await make_user(statementUser, demo_password, statementCreatorRole, statementCreatorLogin)

    await runQuery(pool,`GRANT INSERT ON ${transactionsTable} TO ${consumerRole};`)
    await runQuery(pool,`GRANT INSERT ON ${transactionsByUserTable} TO ${consumerRole};`)
    await runQuery(pool,`GRANT SELECT, INSERT, UPDATE ON ${kafkaOffsetTable} TO ${consumerRole};`)

    await runQuery(pool,`GRANT SELECT, INSERT ON ${usersTable} TO ${statementCreatorRole};`)
    await runQuery(pool,`GRANT SELECT ON ${transactionsByUserTable} TO ${statementCreatorRole};`)
    await runQuery(pool,`GRANT SELECT ON ${transactionsTable} TO ${statementCreatorRole};`)

    await runQuery(pool,`ALTER ROLE ${statementCreatorRole} ADD MEMBER ${statementUser};`);
    await runQuery(pool,`ALTER ROLE ${consumerRole} ADD MEMBER ${consumerUser};`);

    await runQuery(pool,insertionProcedureQuery(addTransactionProcedure, transactionsTable, transactionColumns));
    await runQuery(pool, insertionProcedureQuery(addTransactionByUserProcedure, transactionsByUserTable, transactionsByUserColumns));
    await runQuery(pool, `${insertionProcedureQuery(addKafkaOffsetProcedure, kafkaOffsetTable, kafkaOffsetColumns)}
        ON DUPLICATE KEY UPDATE ${last(kafkaOffsetColumns)?.name} = @${last(kafkaOffsetColumns)?.name};
    `);
    await runQuery(pool, `
        CREATE PROCEDURE ${addUserProcedure}
        ${columnsToProcedureTypes(userColumns)}
        AS
        SET NOCOUNT ON;
        IF NOT EXISTS (SELECT 1 FROM ${usersTable} WHERE ${userColumns[0]} = @${userColumns[0]})
        INSERT INTO ${usersTable} (${columnsToValues(userColumns)})
        VALUES (${columnsToProcedureInputs(userColumns)});
    `);
    await runQuery(pool, `
        CREATE PROCEDURE ${updateTransactionStatusProcedure}
        ${columnsToProcedureTypes([transactionColumns[0], last(transactionColumns)!])}
        AS
        SET NOCOUNT ON;
        UPDATE ${transactionsTable}
        SET ${last(transactionColumns)!.name} = @${last(transactionColumns)!.name}
        WHERE ${transactionColumns[0].name} = @${transactionColumns[0].name};
    `);
}



// sql.on('error', (e: string) => {
//     console.error(`SOME SQL ERROR ${e}`);
// })

export class UserConnection {
    static async create(): Promise<UserConnection> {
        sql.map.register(Date, sql.DateTime2(3));
        const pool = await connectToDatabase(consumerLogin, database);
        
        // await runQuery(pool, `ALTER USER ${consumerLogin} WITH DEFAULT_SCHEMA = ${database};`).then(r => console.log(`principals1 ${JSON.stringify(r)}`))
        // await runQuery(pool, `select * from sys.server_principals where name ;`).then(r => console.log(`principals1 ${JSON.stringify(r)}`))
        // await runQuery(pool, `select name from sys.database_principals;`).then(r => console.log(`principals2 ${JSON.stringify(r)}`))
        // throw new Error(`done`)
        return new UserConnection(pool);
    }
    private constructor(private pool: sql.ConnectionPool) {

    }
    async writeTransactionAndOffsetTransactionally(
        record: { type: "t", r: Transaction[] } | {type: "r", r: TransactionResult[]},
        groupId: number,
        offset: string,
        partition: number,
        topic: string
    ): Promise<void> {
        const transaction = new sql.Transaction(this.pool)
        try {
            // TODO: see how to batch/prepare this
            await transaction.begin()
            if (record.type == "t") {
                for (const r of record.r) {
                    await this.addUserRecord(r.userIdFrom, `User ${r.userIdFrom}`);
                    await this.addUserRecord(r.userIdTo, `User ${r.userIdTo}`);
                    await this.addTransactionRecord(r);
                    await this.addTransactionByUserRecord(r.userIdFrom, r.dateTime, r.id);
                }
            } else {
                for (const rec of record.r) {
                    await this.addTransactionByUserRecord(rec.transactionID, rec.dateTime, rec.transactionID);
                }
            }
            await this.commitOffset(groupId, offset, topic, partition)
            await transaction.commit()
        } catch (error) {
            await transaction.rollback()
            throw error
        }
    }
    async addTransactionRecord(record: Transaction) {
        const request = this.pool.request()
        request.input(transactionColumns[0].name, sql.BigInt, record.id)
        request.input(transactionColumns[1].name, sql.DateTime2(3), new Date(record.dateTime))
        request.input(transactionColumns[2].name, sql.Decimal(18, 2), record.amount)
        request.input(transactionColumns[3].name, sql.BigInt, record.userIdFrom)
        request.input(transactionColumns[4].name, sql.BigInt, record.userIdTo)
        request.input(transactionColumns[5].name, sql.TinyInt, TResult.UNDEFINED)
        await request.execute(addTransactionProcedure);            
    }
    async addTransactionByUserRecord(userId: number, dateTime: number, statementId: number) {
        const request = this.pool.request()
        request.input(transactionsByUserColumns[0].name, sql.BigInt, userId)
        request.input(transactionsByUserColumns[1].name, sql.DateTime2(3), new Date(dateTime))
        request.input(transactionsByUserColumns[2].name, sql.BigInt, statementId)
        await request.execute(addTransactionByUserProcedure);
    }
    async addUserRecord(id: number, name: string) {
        const request = this.pool.request()
        request.input(userColumns[0].name, sql.BigInt, id)
        request.input(userColumns[1].name, sql.NVarChar(100), name)
        await request.execute(addUserProcedure);
    }
    async updateTransactionStatus(transactionId: number, state: TResult) {
        const request = this.pool.request()
        request.input(transactionColumns[0].name, sql.BigInt, transactionId)
        request.input(last(transactionColumns)!.name, sql.TinyInt, state)
        await request.execute(updateTransactionStatusProcedure);
    }
    async commitOffset(groupId: number, offset: string, topic: string, partition: number = 0) {
        const request = this.pool.request()
        request.input(kafkaOffsetColumns[0].name, sql.BigInt, groupId)
        request.input(kafkaOffsetColumns[1].name, sql.NVarChar(100), topic)
        request.input(kafkaOffsetColumns[2].name, sql.Int, partition)
        request.input(kafkaOffsetColumns[3].name, sql.NVarChar(18), offset)
        await request.execute(addKafkaOffsetProcedure);
    }
}
 