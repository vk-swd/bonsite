import { Transaction, TResult } from './event_types.js'
import { getEnv } from './utils.js'

import sql from 'mssql'



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

function connectToDatabase(user: string, database?: string): Promise<sql.ConnectionPool> {
    return sql.connect({
        user: user,
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
export async function createSchema() {
    const pool = await connectToDatabase(user_sa);
    await runQuery(pool, `create database [${database}]`)
    await runQuery(pool, `use ${database};`)
    await runQuery(pool, `create schema [${schema}]`)
    await runQuery(pool,
        `CREATE TABLE ${usersTable} (
            id BIGINT IDENTITY(1,1)  PRIMARY KEY,
            Name NVARCHAR(100) NOT NULL
        );`)

    await runQuery(pool,
        `CREATE TABLE ${transactionsTable} (
            StatementId BIGINT PRIMARY KEY, -- ids should not auto increment for idempotency.
            Date DATETIME2(3) NOT NULL,
            Amount DECIMAL(18,2) NOT NULL,
            FromUserId BIGINT NOT NULL,
            ToUserId BIGINT NOT NULL,
            Status TINYINT NOT NULL
            
            FOREIGN KEY (FromUserId) REFERENCES ${usersTable}(id),
            FOREIGN KEY (ToUserId) REFERENCES ${usersTable}(id)
        );`)

    await runQuery(pool,
        `CREATE TABLE ${transactionsByUserTable} ( 
            Date DATETIME2(3) NOT NULL,
            UserId BIGINT NOT NULL,
            StatementId BIGINT,
            
            FOREIGN KEY (StatementId) REFERENCES ${transactionsTable}(StatementId),
            FOREIGN KEY (UserId) REFERENCES ${usersTable}(id)
        );`)

    await runQuery(pool,
        `CREATE NONCLUSTERED INDEX idx_c_transactionsByUser ON ${transactionsByUserTable} (UserId, Date) INCLUDE (StatementId);`
    )
    await runQuery(pool,
        `CREATE TABLE ${kafkaOffsetTable} (
            Groupid BIGINT,
            Topic NVARCHAR(100) NOT NULL,
            Partition INT NOT NULL,
            Offset DECIMAL(18,2) NOT NULL,
            PRIMARY KEY (GroupId, Topic, Partition)
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

    /*
    CREATE PROCEDURE TransferFunds
    @FromUserId INT,
    @ToUserId INT,
    @Amount DECIMAL(18,2)
AS
BEGIN
    SET NOCOUNT ON;
    BEGIN TRANSACTION;

    BEGIN TRY
        -- Debit from sender
        UPDATE Accounts
        SET Balance = Balance - @Amount
        WHERE UserId = @FromUserId;

        -- Credit to receiver
        UPDATE Accounts
        SET Balance = Balance + @Amount
        WHERE UserId = @ToUserId;

        -- Log transaction
        INSERT INTO Transactions (FromUserId, ToUserId, Amount, CreatedAt)
        VALUES (@FromUserId, @ToUserId, @Amount, GETDATE());

        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        ROLLBACK TRANSACTION;
        THROW; -- rethrow error
    END CATCH
END;

    
    */


    // -- Creates a nonclustered index on the Person.Address table with four included (nonkey) columns.
    // -- index key column is PostalCode and the nonkey columns are
    // -- AddressLine1, AddressLine2, City, and StateProvinceID.

    // ON Person.Address (PostalCode)
    // INCLUDE (AddressLine1, AddressLine2, City, StateProvinceID);
    // GO
}

async function addTransactionRecord(record: Transaction, state: TResult) {
    const pool = await sql.connect({ user: user_sa, password: demo_password, server, database, options: { trustServerCertificate: true } })
    const request = pool.request()
    request.input('StatementId', sql.BigInt, record.id)
    request.input('Date', sql.DateTime2(3), new Date(record.dateTime))
    request.input('Amount', sql.Decimal(18, 2), record.amount)
    request.input('FromUserId', sql.BigInt, record.userIdFrom)
    request.input('ToUserId', sql.BigInt, record.userIdTo)
    request.input('Status', sql.TinyInt, state)

    await request.query(
        `INSERT INTO ${transactionsTable} (StatementId, Date, Amount, FromUserId, ToUserId, Status)
         VALUES (@StatementId, @Date, @Amount, @FromUserId, @ToUserId, @Status)`)
}

async function commitOffset(groupId: number, offset: number) {
    const pool = await sql.connect({ user: user_sa, password: demo_password, server, database, options: { trustServerCertificate: true } })
    const request = pool.request()
    request.input('Groupid', sql.BigInt, groupId)
    request.input('Offset', sql.Decimal(18, 2), offset)

    await request.query(
        `INSERT INTO ${kafkaOffsetTable} (Groupid, Offset)
         VALUES (@Groupid, @Offset)
         ON DUPLICATE KEY UPDATE Offset = @Offset`)
}


export async function writeTransactionAndOffsetTransactionally(
    record: Transaction,
    state: TResult,
    groupId: number,
    offset: number
): Promise<void> {
    const pool = await sql.connect({ user: user_sa, password: demo_password, server, database, options: { trustServerCertificate: true } })
    const transaction = new sql.Transaction(pool)
    try {
        await transaction.begin()
        await addTransactionRecord(record, state)
        await commitOffset(groupId, offset)
        await transaction.commit()
    } catch (error) {
        await transaction.rollback()
        throw error
    } finally {
        pool.close()
    }
}