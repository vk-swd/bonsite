import { consumerRole, consumerUser, roles, statementCreatorRole, statementUser, users } from "./auth.js";
import { connectToDatabase, database, runQuery } from "./common.js";
import { addKafkaOffsetProcedure, commitRecordedTransacrionResultsProc, commitRecordedTransacrionsProc, getRawDataRecordsProc, procGetTransactions, setUpTempTransactionResultsTable, setUpTempTransactionsTable } from "./procedures.js";
import { ColumnDescription, kafkaOffsetTable, rawDataTable, schema, transactionResultsTable, transactionsByUserTable, transactionsTable, usersTable } from "./tables.js";
import { getEnv } from '../utils.js'


const user_sa = getEnv('MSSQL_SA_USERNAME')
const demo_password = getEnv('MSSQL_PASSWORD')


function columnsToString(columns: ColumnDescription[]): string {
    return columns.map(c => `${c.name} ${c.type}${c.extra ? ' '+ c.extra : ''}`).join(',\n');
}
export async function createSchema() {
    try {
        const pool = await connectToDatabase(user_sa);
        await runQuery(pool, `IF DB_ID('${database}') IS not NULL
                drop database [${database}];
        `)

        for (const user of users) {
            for (const u of [`user [${user.name}]`, `login [${user.login}]`]) {
                await runQuery(pool, 
                `BEGIN TRY
                    BEGIN
                        drop ${u};
                    END
                END TRY
                begin catch
                end catch
                `)
            }
        }
        
        await runQuery(pool, `create database [${database}]`)
        await runQuery(pool, `use ${database};`)
        await runQuery(pool, `create schema [${schema}]`)
        for (const role of roles) {
            await runQuery(pool, `CREATE ROLE ${role}`);
        }
        for (const table of [
            transactionsTable,
            transactionResultsTable,
            usersTable,
            kafkaOffsetTable,
            transactionsByUserTable,
            rawDataTable]) {
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
        
        for (const user of users) {
            await runQuery(pool, `CREATE LOGIN ${user.login} WITH PASSWORD = '${demo_password}'`)
            await runQuery(pool, `CREATE USER ${user.name} FOR LOGIN ${user.login}`);
        }

        await runQuery(pool,`ALTER ROLE ${statementCreatorRole} ADD MEMBER ${statementUser.name};`);
        await runQuery(pool,`ALTER ROLE ${consumerRole} ADD MEMBER ${consumerUser.name};`);
        
        const procs = [ addKafkaOffsetProcedure, commitRecordedTransacrionsProc, 
                        commitRecordedTransacrionResultsProc, procGetTransactions, 
                        getRawDataRecordsProc,
                        setUpTempTransactionResultsTable.getInsertionProcedure(),
                        setUpTempTransactionsTable.getInsertionProcedure() ];
        for (const proc of procs) {
            // console.log(`Creating procedure ${proc.getProcedureQuery()}`);
            const cre = await runQuery(pool, proc.getProcedureQuery());
            const grant = await runQuery(pool, `GRANT EXECUTE ON ${proc.name} TO ${consumerRole};`);
            // console.log(`Creating procedure ${proc.name} - ${JSON.stringify(cre)} grant - ${JSON.stringify(grant)}`);
        }
        // await setUpTempTransactionsTable.batch(pool.request())
        await pool.close();
    } catch (e) {
        console.error(`Error creating schema: ${e}`);
        throw e;
    }
}