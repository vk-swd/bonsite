import { roles, sinkRole, statementCreatorRole } from "./auth.js";
import { database, runQuery } from "./common.js";
import { addKafkaOffsetProcedure, procGetTransactions, setUpTempTransactionResultsTable, setUpTempTransactionsTable } from "./procedures.js";
import { Column, kafkaOffsetTable, rawDataTable, schema, statTable, transactionResultsDumpTable, transactionResultsTable, transactionsDumpTable, transactionsTable, usersTable } from "./tables.js";
import { getEnv } from '../utils.js'
import sql from 'mssql'

const demo_password = getEnv('MSSQL_PASSWORD')

function columnsToString<T, K extends keyof T>(columns: Column<T,K>[]): string {
    return columns.map(c => `${c.name} ${c.type.name}${c.extra ? ' '+ c.extra : ''}`).join(',\n');
}
export async function createSchema(pool: sql.ConnectionPool, databaseA: string = database) {
    await runQuery(pool, `use master;`)
    try {
        await runQuery(pool, `IF DB_ID('${databaseA}') IS not NULL
                drop database [${databaseA}];
        `)       
        await runQuery(pool, `create database [${databaseA}]`)
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
  
        await runQuery(pool, procGetTransactions.getProcedureQuery());
        await runQuery(pool, `GRANT EXECUTE ON ${procGetTransactions.procName} TO ${statementCreatorRole};`);

        const procs = [ addKafkaOffsetProcedure, 
                        setUpTempTransactionResultsTable.getInsertionProcedure(),
                        setUpTempTransactionResultsTable.getCommitProcedure(),
                        setUpTempTransactionsTable.getCommitProcedure(),
                        setUpTempTransactionsTable.getInsertionProcedure() ];
        for (const proc of procs) {
            await runQuery(pool, proc.getProcedureQuery());
            await runQuery(pool, `GRANT EXECUTE ON ${proc.procName} TO ${sinkRole};`);
        }
        // await setUpTempTransactionsTable.batch(pool.request())
    } catch (e) {
        console.error(`Error creating schema: ${e}`);
        throw e;
    }
}