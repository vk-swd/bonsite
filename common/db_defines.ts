import { Transaction, TransactionResult, TResult } from './event_types.js'
import { getEnv, KConsumerOffsetInfo, last } from './utils.js'

import sql from 'mssql'
import { logger } from './logger.js'

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
    jsType?: string; // optional, used for type inference
}


const transactionColumns: ColumnDescription[] = [
    { name: 'StatementId', type: 'BIGINT', extra: 'PRIMARY KEY' },
    { name: 'Date', type: 'DATETIME' },
    { name: 'Amount', type: 'DECIMAL(18,2)' },
    { name: 'FromUserId', type: 'BIGINT' },
    { name: 'ToUserId', type: 'BIGINT' },
    { name: 'Status', type: 'TINYINT' }
]
const userColumns: ColumnDescription[] = [
    { name: 'id', type: 'BIGINT', extra: ' PRIMARY KEY' }, //IDENTITY(1,1)
    { name: 'Name', type: 'NVARCHAR(100)', extra: ' NOT NULL' }
]
const transactionsByUserColumns: ColumnDescription[] = [
    { name: 'UserId', type: 'BIGINT', extra: ' NOT NULL' },
    { name: 'Date', type: 'DATETIME', extra: ' NOT NULL' },
    { name: 'StatementId', type: 'BIGINT' },
]
const kafkaOffsetColumns: ColumnDescription[] = [
    { name: 'Groupid', type: 'NVARCHAR(18)', extra: ' NOT NULL' },
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
function columtEqArg(c: ColumnDescription) {
    return `${c.name} = @${c.name}`;
}
function compareColumnsToArgs (c: ColumnDescription[]) {
    return c.map(columtEqArg).join(' AND ');
}

function procedureQuery(procedureName: string, columns: ColumnDescription[], tail: string): string {
    return `CREATE PROCEDURE ${procedureName}
        ${columnsToProcedureTypes(columns)}
        AS
        SET NOCOUNT ON;
        ${tail}`;
}
function updateQuery(tableName: string, updatedColumn: ColumnDescription[], lookedUpColumns: ColumnDescription[]): string {
    return `UPDATE ${tableName}
            SET  ${updatedColumn.map(c => `${columtEqArg(c)}`).join(', ')}
            WHERE ${compareColumnsToArgs(lookedUpColumns)};`
}
function insertQuery(tableName: string, columns: ColumnDescription[]): string {
    return `INSERT INTO ${tableName} (${columnsToValues(columns)})
            VALUES (${columnsToProcedureInputs(columns)});`
}
function ifExistsQuery(tableName: string, lookedUpColumns: ColumnDescription[]): string {
    return `EXISTS (SELECT 1
            FROM ${tableName}
            WHERE ${compareColumnsToArgs(lookedUpColumns)})`
}

const addTransactionProcedure = `${schema}.addTransactionRecord`;
const addUserProcedure = `${schema}.addUser`;
const updateTransactionStatusProcedure = `${schema}.updateTransactionStatus`;
const addTransactionByUserProcedure = `${schema}.addTransactionByUser`;
const addKafkaOffsetProcedure = `${schema}.addKafkaOffset`;

export async function createSchema() {
    try {
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
            `CREATE NONCLUSTERED INDEX idx_c_transactionsByUser 
            ON ${transactionsByUserTable} (${columnsToValues(transactionsByUserColumns.slice(0,-1))}) 
            INCLUDE (${last(transactionsByUserColumns)!.name});`
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
        await runQuery(pool,`GRANT SELECT, INSERT ON ${usersTable} TO ${consumerRole};`)
        await runQuery(pool,`GRANT SELECT, INSERT, UPDATE ON ${kafkaOffsetTable} TO ${consumerRole};`)

        await runQuery(pool,`GRANT SELECT, INSERT ON ${usersTable} TO ${statementCreatorRole};`)
        await runQuery(pool,`GRANT SELECT ON ${transactionsByUserTable} TO ${statementCreatorRole};`)
        await runQuery(pool,`GRANT SELECT ON ${transactionsTable} TO ${statementCreatorRole};`)

        await runQuery(pool,`ALTER ROLE ${statementCreatorRole} ADD MEMBER ${statementUser};`);
        await runQuery(pool,`ALTER ROLE ${consumerRole} ADD MEMBER ${consumerUser};`);

        await runQuery(pool, 
            procedureQuery(addTransactionProcedure, transactionColumns, `
                if ${ifExistsQuery(transactionsTable, [transactionColumns[0]])}
                    ${updateQuery(transactionsTable, transactionColumns.slice(1,-1), [transactionColumns[0]])} 
                else 
                    ${insertQuery(transactionsTable, transactionColumns)}
        `));
        await runQuery(pool, 
            procedureQuery(updateTransactionStatusProcedure, [transactionColumns[0], last(transactionColumns)!], `
                if ${ifExistsQuery(transactionsTable, [transactionColumns[0]])}
                    ${updateQuery(transactionsTable, [last(transactionColumns)!], [transactionColumns[0]])} 
                else 
                    ${insertQuery(transactionsTable, [transactionColumns[0], last(transactionColumns)!])}
        `));
        await runQuery(pool, 
            procedureQuery(addKafkaOffsetProcedure, kafkaOffsetColumns, `
                if ${ifExistsQuery(kafkaOffsetTable, kafkaOffsetColumns.slice(0,-1))}
                    ${updateQuery(kafkaOffsetTable, [last(kafkaOffsetColumns)!], kafkaOffsetColumns.slice(0,-1))}
                else 
                    ${insertQuery(kafkaOffsetTable, kafkaOffsetColumns)}
            `)
        );
        await runQuery(pool, 
            procedureQuery(addTransactionByUserProcedure, transactionsByUserColumns,
                insertQuery(transactionsByUserTable, transactionsByUserColumns)));
      
        await runQuery(pool, 
            procedureQuery(addUserProcedure, userColumns, `
            IF NOT ${ifExistsQuery(usersTable, [userColumns[0]])}
                ${insertQuery(usersTable, userColumns)}
            `)
        );
        await runQuery(pool, `GRANT EXECUTE ON ${addTransactionProcedure} TO ${consumerRole};`);
        await runQuery(pool, `GRANT EXECUTE ON ${addTransactionByUserProcedure} TO ${consumerRole};`);
        await runQuery(pool, `GRANT EXECUTE ON ${addKafkaOffsetProcedure} TO ${consumerRole};`);
        await runQuery(pool, `GRANT EXECUTE ON ${updateTransactionStatusProcedure} TO ${consumerRole};`);
        await runQuery(pool, `GRANT EXECUTE ON ${addUserProcedure} TO ${consumerRole};`);    
    } catch (e) {
        console.error(`Error creating schema: ${e}`);
        throw e;
    }
}

export class Offsets {
    static create(gropuId: string, queryResult: sql.IResult<any>): Offsets {
        const mapping = new Map<string, string>();
        // console.log(`recordset: ${JSON.stringify(queryResult.recordset)}`);
        // console.log(`output: ${JSON.stringify(queryResult.recordset.map(r => typeof r))}`);
        if (queryResult.recordset.length == 0 || 
            queryResult.recordset.filter(r => typeof r !== 'object').length != 0
        ) {
            return new Offsets(mapping);
        }
        // queryResult.recordset.forEach(r => kafkaOffsetColumns.forEach(c => 
        //     console.log(`typeof ${c.name} is ${typeof r[c.name]}`)));

        const records = queryResult.recordset.map(r => JSON.parse(r));
        records.filter(r => r[kafkaOffsetColumns[0].name] == gropuId).forEach(row => {
            mapping.set(`${row[kafkaOffsetColumns[1].name]}-${row[kafkaOffsetColumns[2].name]}`, 
                row[kafkaOffsetColumns[3].name]);
        });
        return new Offsets(mapping); 
    }
    private constructor(private mapping: Map<string, string>) {
    }
    getOffset(topic: string, partition: number = 0): string | undefined {
        return this.mapping.get(`${topic}-${partition}`);
    }
}

export class UserConnection {
    static async create(): Promise<UserConnection> {
        sql.map.register(Date, sql.DateTime2(3));
        const pool = await connectToDatabase(consumerLogin, database);
        return new UserConnection(pool);
    }
    private constructor(private pool: sql.ConnectionPool) {
    }
    isConnectionAlive(): boolean {
        return this.pool.connected;
    }
    async writeTransactionAndOffsetTransactionally(
        record: { type: "t", r: Transaction[] } | {type: "r", r: TransactionResult[]},
        groupId: string,
        offset: string,
        partition: number,
        topic: string
    ): Promise<void> {
        const transaction = new sql.Transaction(this.pool)
        let iter = 0;
        let iter2 = 0;
        try {
            // TODO: see how to batch/prepare this
            await transaction.begin()
            if (record.type == "t") {
                for (let i = 0; i < record.r.length; i++) {
                    const r = record.r[i];
                    await this.addUserRecord(r.userIdFrom, `User ${r.userIdFrom}`);
                    await this.addUserRecord(r.userIdTo, `User ${r.userIdTo}`);
                    await this.addTransactionRecord(r);
                    await this.addTransactionByUserRecord(r.userIdFrom, r.dateTime, r.id);
                    await this.addTransactionByUserRecord(r.userIdTo, r.dateTime, r.id);
                    iter++;
                }
            } else {
                for (const rec of record.r) {
                    await this.updateTransactionStatus(rec.transactionID, rec.state);
                    iter2++;
                }
            }
            /*  Updating a shared database table (e.g., Kafka offsets) is prone to race conditions. 
                Here it is assumed that Kafka partitions are sharded by user ID (or another unique key). 
                This guarantees no key overlap, enabling safe parallel writes.
                No locking is used.
                But this assumptions needs to be enforced by some external service.
                This demo uses a single database writer so this service won't be implemented.
            */
            await this.commitOffset(groupId, offset, topic, partition)
            await transaction.commit()
        } catch (error) {
            await transaction.rollback()
            throw error +` ${iter} transactions and ${iter2} results were processed`;
        }
    }

    async addTransactionRecord(record: Transaction) {
        const request = this.pool.request()
        try {
            request.input(transactionColumns[0].name, sql.BigInt, record.id)
            request.input(transactionColumns[1].name, sql.DateTime, new Date(record.dateTime).toISOString())
            request.input(transactionColumns[2].name, sql.Decimal(18, 2), record.amount)
            request.input(transactionColumns[3].name, sql.BigInt, record.userIdFrom)
            request.input(transactionColumns[4].name, sql.BigInt, record.userIdTo)
            request.input(transactionColumns[5].name, sql.TinyInt, TResult.UNDEFINED)
            await request.execute(addTransactionProcedure);  
        } catch (e) {
            throw `Failed to add transaction record ${JSON.stringify(record)}: ${e}`
        }
    }
    async addTransactionByUserRecord(userId: number, dateTime: number, statementId: number) {
        const request = this.pool.request()
        try {
            request.input(transactionsByUserColumns[0].name, sql.BigInt, userId)
            request.input(transactionsByUserColumns[1].name, sql.DateTime, new Date(dateTime).toISOString())
            request.input(transactionsByUserColumns[2].name, sql.BigInt, statementId) 
            await request.execute(addTransactionByUserProcedure);
        } catch (e) {
            console.error(`Failed to add transaction by user record for userId ${userId}
                dateTime ${dateTime} and statementId ${statementId}: ${e}`);
            throw e;
        }
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
    async commitOffset(groupId: string, offset: string, topic: string, partition: number = 0) {
        logger.log(`Committing offset ${offset} for group ${groupId}, topic ${topic}, partition ${partition}`);
        const request = this.pool.request()
        request.input(kafkaOffsetColumns[0].name, sql.BigInt, groupId)
        request.input(kafkaOffsetColumns[1].name, sql.NVarChar(100), topic)
        request.input(kafkaOffsetColumns[2].name, sql.Int, partition)
        request.input(kafkaOffsetColumns[3].name, sql.NVarChar(18), offset)
        const results = await request.execute(addKafkaOffsetProcedure);
        logger.log(`Results of committing offset: ${JSON.stringify(results)}`);
    }
    async getOffsets(groupId: string, topics: KConsumerOffsetInfo[]): Promise<Offsets | undefined> {
        const request = this.pool.request()
        let query = `SELECT TOP 1 * FROM ${kafkaOffsetTable} WHERE `

        query += `${columtEqArg(kafkaOffsetColumns[0])}`
        request.input(kafkaOffsetColumns[0].name, sql.BigInt, Number(groupId))

        query += ` AND `;

        query += `(`

        query += `${topics.map((topic, t_idx) => {
            const tParamName = kafkaOffsetColumns[1].name + `${t_idx}`;
            let topicLine = `(`;
            
            topicLine += ` ${kafkaOffsetColumns[1].name} = @${tParamName}`;
            request.input(tParamName, sql.NVarChar(100), topic)

            topicLine += ` AND `
            
            topicLine += `${kafkaOffsetColumns[2].name} IN `
            topicLine += `(${topic.partitions.map((partition, p_idx) => {
                const pParamName = kafkaOffsetColumns[2].name + `${t_idx}${p_idx}`;
                request.input(pParamName, sql.Int, partition.id);
                return `@${pParamName}`;
            }).join(',')})`;
            
            topicLine = `)`;
            return topicLine;
        }).join(` OR `)}`;

        query += `)`
        
        const result = await request.query(query);
        console.log(`records: ${JSON.stringify(result.recordset)}`);
        console.log(`outputs: ${kafkaOffsetColumns.forEach(c => console.log(`output ${c.name} => ${result.output[c.name]}`))}`);
        console.log(`columns: ${JSON.stringify(result.recordset.columns)}`);
        if (result.recordsets.length == 0) {
            return undefined;
        }
        return Offsets.create(groupId, result);
    }
}
 
