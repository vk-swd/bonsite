import { Transaction, TResult } from './event_types.js'
import { getEnv } from './utils.js'

import sql from 'mssql'



const user = getEnv('MSSQL_USER')
const password = getEnv('MSSQL_PASSWORD')
const database = getEnv('MSSQL_DB_NAME')
const server = getEnv('MSSQL_HOSTNAME')

const schema = 'scm'
const transactionsTable = `${schema}.transactions`
const usersTable = `${schema}.users`
const kafkaOffsetTable = `${schema}.kafka_offsets`
const transactionsByUser = `${schema}.transactions_by_user`

export async function createSchema() {
    const pool = await sql.connect({ user, password, server, options: { trustServerCertificate: true } })
    await pool.request().query(
        `if not exists (select name from sys.databases where name = '${database}') create database ${database}`)
    await pool.request().query(`use ${database};`)
    await pool.request().query(`create schema ${schema}`)
    .catch(e => console.error(`Couldn't make "if not exists" work with schemas or find atomic way to do it, so...catching: ${e}`));
    
    await pool.request().query(
        `if not exists (select name from sys.tables where object_id=OBJECT_ID('${usersTable}'))
        CREATE TABLE ${usersTable} (
            id BIGINT IDENTITY(1,1)  PRIMARY KEY,
            Name NVARCHAR(100) NOT NULL
        );`)

    await pool.request().query(
        `if not exists (select name from sys.tables where object_id=OBJECT_ID('${transactionsTable}'))
        CREATE TABLE ${transactionsTable} (
            StatementId BIGINT PRIMARY KEY, -- ids should not auto increment for idempotency.
            Date DATETIME2(3) NOT NULL,
            Amount DECIMAL(18,2) NOT NULL,
            FromUserId BIGINT NOT NULL,
            ToUserId BIGINT NOT NULL,
            Status TINYINT NOT NULL
            
            FOREIGN KEY (FromUserId) REFERENCES ${usersTable}(id),
            FOREIGN KEY (ToUserId) REFERENCES ${usersTable}(id)
        );`)

    await pool.request().query(
        `if not exists (select name from sys.tables where object_id=OBJECT_ID('${transactionsByUser}'))
        CREATE TABLE ${transactionsByUser} ( 
            Date DATETIME2(3) NOT NULL,
            UserId BIGINT NOT NULL,
            StatementId BIGINT,
            
            FOREIGN KEY (StatementId) REFERENCES ${transactionsTable}(StatementId),
            FOREIGN KEY (UserId) REFERENCES ${usersTable}(id)
        );`)

    await pool.request().query(
        `if not exists (select name from sys.indexes where name = 'idx_c_transactionsByUser' and object_id = OBJECT_ID('${transactionsByUser}'))
        CREATE NONCLUSTERED INDEX idx_c_transactionsByUser ON ${transactionsByUser} (UserId, Date) INCLUDE (StatementId);`
    )
    await pool.request().query(
        `if not exists (select name from sys.tables where object_id=OBJECT_ID('${kafkaOffsetTable}'))
        CREATE TABLE ${kafkaOffsetTable} (
            Groupid BIGINT,
            Topic NVARCHAR(100) NOT NULL,
            Partition INT NOT NULL,
            Offset DECIMAL(18,2) NOT NULL,
            PRIMARY KEY (GroupId, Topic, Partition)
        );`)
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
    const pool = await sql.connect({ user, password, server, database, options: { trustServerCertificate: true } })
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
    const pool = await sql.connect({ user, password, server, database, options: { trustServerCertificate: true } })
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
    const pool = await sql.connect({ user, password, server, database, options: { trustServerCertificate: true } })
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