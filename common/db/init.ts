import { logger } from "../logger.js";
import { roles, sinkRole, sinkUser, statementCreatorRole, statementUser } from "./auth.js";
import { connectToDatabase, runQuery } from "./common.js";
import { addKafkaOffsetProcedure, getDBStatProc, getUserDateRangeProc, getUsersProc, getUsersTopProc, procGetTransactions, RotateTableProc, setUpTempTransactionResultsTable, setUpTempTransactionsTable } from "./procedures.js";
import { Column, kafkaOffsetTable, rawDataTable, schema, statTable, statTableReads, transactionResultsDumpTable, transactionResultsTable, transactionsDumpTable, transactionsTable, usersTable } from "./tables.js";
import sql from 'mssql'

function columnsToString<T, K extends keyof T>(columns: Column<T,K>[]): string {
    return columns.map(c => `${c.inputName} ${c.type.name}${c.extra ? ' '+ c.extra : ''}`).join(',\n');
}

export async function initializeDatabase(user_sa: string, passwd_sa: string, hostname: string, otherPasswd: string, dbName: string) {
    let pool: sql.ConnectionPool | undefined = undefined;
    try {
        pool = await connectToDatabase(user_sa, passwd_sa, hostname, "master");
    } catch (e) {
        logger.log(`Error connecting to db: `, e);
        return false;
    }
    try {
        await createSchema(pool, dbName);
        await runQuery(pool, `use ${dbName};`)
        for (const user of [sinkUser, statementUser]) {
            await runQuery(pool, `
                BEGIN TRY
                    drop login ${user};
                END TRY
                begin catch
                end catch`)
                await runQuery(pool, `CREATE LOGIN ${user} WITH PASSWORD = '${otherPasswd}'`)
                await runQuery(pool, `CREATE USER ${user} FOR LOGIN ${user}`);
        }
        await runQuery(pool,`ALTER ROLE ${statementCreatorRole} ADD MEMBER ${statementUser};`);
        await runQuery(pool,`ALTER ROLE ${sinkRole} ADD MEMBER ${sinkUser};`);
        await runQuery(pool,`ALTER ROLE db_owner ADD MEMBER ${sinkUser};`);

        await runQuery(pool,`
            EXECUTE sp_configure 'show advanced options', 1;
            RECONFIGURE;
            EXEC sp_configure 'max server memory (MB)', 8000000;
            RECONFIGURE;
        `);
    } catch (e) {
        logger.log(`Error initializing db: `, e);
        pool.close()
        return false;
    }
    pool.close()
    return true;
}

export async function createSchema(pool: sql.ConnectionPool, databaseA: string) {
    await runQuery(pool, `use master;`)
    try {
        await runQuery(pool, `IF DB_ID('${databaseA}') IS not NULL
                drop database [${databaseA}];
        `)
        logger.log(`Creating database ${databaseA}`);
        await runQuery(pool, `create database [${databaseA}]
            ON PRIMARY(
                NAME = ${databaseA}_dat,
                FILENAME = '/tmp/${databaseA}.mdf',
                SIZE = 100 MB,
                MAXSIZE = 4 GB,
                FILEGROWTH = 15 %
            )LOG ON (
                NAME = ${databaseA}_log,
                FILENAME = '/tmp/${databaseA}_log.ldf',
                SIZE = 500 MB,
                MAXSIZE = 500 MB,
                FILEGROWTH = 0
            )`)
            logger.log(`Database ${databaseA} created`);

            
        await runQuery(pool, `ALTER DATABASE [${databaseA}] SET RECOVERY SIMPLE;`)
        await runQuery(pool, `use ${databaseA};`)
        await runQuery(pool, `create schema [${schema}]`)
        for (const role of roles) {
            await runQuery(pool, `CREATE ROLE ${role}`);
        }
        for (const table of [
            transactionsTable,
            transactionResultsTable,
            usersTable,
            kafkaOffsetTable,
            rawDataTable,
            statTable,
            statTableReads,
            transactionsDumpTable,
            transactionResultsDumpTable]) {
            await runQuery(pool, `CREATE TABLE ${table.name} (
                ${columnsToString(Object.values(table.columns))}
                ${table.foreignKeys?.forEach(fk => `FOREIGN KEY (${fk.column}) REFERENCES ${fk.references}`) || ''}
                ${table.primaryKey ? `PRIMARY KEY (${table.primaryKey.join(', ')})` : ''}
            )
            `)
            if (table.nonClusteredIndexes) {
                for (const index of table.nonClusteredIndexes) {
                    await runQuery(pool, `CREATE NONCLUSTERED INDEX ${index.name}
                        ON ${table.name} (${index.columns.join(', ')})
                        ${index.include ? `INCLUDE (${index.include.join(', ')})` : ''};`);
                }
            }
            for (const p of table.permissions) {
                await runQuery(pool, `GRANT ${p.permissions.join(', ')} ON ${table.name} TO ${p.role};`);
            }
        }

        const statGenProcs = [procGetTransactions, getUsersProc, getUsersTopProc, 
                              getDBStatProc, getUserDateRangeProc];
        for (const proc of statGenProcs) {
                await runQuery(pool, proc.getProcedureQuery());
                await runQuery(pool, `GRANT EXECUTE ON ${proc.procName} TO ${statementCreatorRole};`);
        }

        const messageSynkProcs = [ addKafkaOffsetProcedure,
                        setUpTempTransactionResultsTable.getCommitProcedure(),
                        setUpTempTransactionsTable.getCommitProcedure(),
                        RotateTableProc ];
        for (const proc of messageSynkProcs) {
            await runQuery(pool, proc.getProcedureQuery());
            await runQuery(pool, `GRANT EXECUTE ON ${proc.procName} TO ${sinkRole};`);
        }
        for (const proc of statGenProcs) {
            await runQuery(pool, `GRANT EXECUTE ON ${proc.procName} TO ${sinkRole};`);
        }
        await runQuery(pool, `GRANT VIEW DATABASE STATE TO ${sinkRole};`);
        await runQuery(pool, `GRANT VIEW DEFINITION TO ${sinkRole};`);
        // await setUpTempTransactionsTable.batch(pool.request())
    } catch (e) {
        console.error(`Error creating schema: ${e}`);
        throw e;
    }
}