import { Transaction, TransactionMessages, TransactionResult, TransactionValidator, TResult } from './event_types.js'
import { getEnv, KConsumerOffsetInfo, last } from './utils.js'

import sql, { columns, Table } from 'mssql'
import { logger } from './logger.js'
import { receiveMessageOnPort } from 'worker_threads'
import { tracingChannel } from 'diagnostics_channel'

const user_sa = getEnv('MSSQL_SA_USERNAME')
const demo_password = getEnv('MSSQL_PASSWORD')
const database = getEnv('MSSQL_DB_NAME')
const server = getEnv('MSSQL_HOSTNAME')
const user_consumer = getEnv('MSSQL_CONSUMER_USERNAME')
const user_statement_creator = getEnv('MSSQL_STATEMENT_CREATOR_USERNAME')


const roles = [`${user_consumer}_role`, `${user_statement_creator}_role`]
const [consumerRole,  statementCreatorRole] = roles
const users: {name: string, login: string}[] = [
    {name: `${user_consumer}_user`, login: `${user_consumer}_login`},
    {name: `${user_statement_creator}_user`, login: `${user_statement_creator}_login`}]
const [consumerUser, statementUser] = users


async function connectToDatabase(login: string, database?: string): Promise<sql.ConnectionPool> {
    const res = new sql.ConnectionPool({
        user: login,
        password: demo_password,
        server,
        database,
        options: { trustServerCertificate: true }
    });
    await res.connect();
    return res;
}
function runQuery(pool: sql.ConnectionPool, query: string): Promise<sql.IResult<any>> {
    return pool.request().query(query).catch(e => {
        console.log(`Error running query: ${query}`, e);
        throw e;
    });
}
type ColumnDescription = {
    name: string;
    type: string;
    references?: ColumnDescription
    extra?: string; // e.g. 'NOT NULL', 'PRIMARY KEY', etc.
    sqlType?: sql.ISqlType; // optional, used for type inference
    jsType?: string; // optional, used for type inference
}

type TableDescription = {
    name: string;
    columns: ColumnDescription[];
    permissions: {role: string, permissions: string[]}[]; // e.g. {user: 'consumer', role: 'consumer_role', permissions: 'SELECT, INSERT'}
    foreignKeys?: { column: string, references: string }[]; // e.g. { column: 'FromUserId', references: 'users(id)' }
    primaryKey?: string[];
    nonClusteredIndexes?: { name: string, columns: string[], include?: string[] }[]; // e.g. { name: 'idx_c_transactionsByUser', columns: ['UserId', 'Date'], include: ['StatementId'] }
    procedures?: Procedures[]; // e.g. { name: 'addTransactionRecord', columns: transactionColumns, tail: '...' }
}
const schema = 'scm'

enum Procedures {
    INSERT = 'INSERT',
    INSERT_CONFLICT_AWARE = 'INSERT_CONFLICT_AWARE',
    UPDATE = 'UPDATE',
    INSERT_IF_NOT_EXISTS = 'INSERT_IF_NOT_EXISTS',
    UPSERT = 'UPSERT'
}
const usersTable: TableDescription ={
    name: `${schema}.users`, columns: [
        { name: 'id', type: 'BIGINT', extra: 'PRIMARY KEY' }, //IDENTITY(1,1)
        { name: 'Name', type: 'NVARCHAR(100)', extra: 'NOT NULL' }
    ], permissions: [
        { role: consumerRole, permissions: ['SELECT', 'INSERT'] },
        { role: statementCreatorRole, permissions: ['SELECT'] }
    ],
    procedures: [ Procedures.INSERT_IF_NOT_EXISTS ],
}
const transactionsTableColumnNames = Object.keys(TransactionValidator.shape);
const transactionsTable: TableDescription = {
        name: `${schema}.transactions`, columns: [
            { name: transactionsTableColumnNames[0], type: 'BIGINT', extra: 'PRIMARY KEY' },
            { name: transactionsTableColumnNames[1], type: 'DATETIME', extra: 'NOT NULL' },
            { name: transactionsTableColumnNames[2], type: 'DECIMAL(18,2)', extra: 'NOT NULL' },
            { name: transactionsTableColumnNames[3], type: 'BIGINT', extra: 'NOT NULL' },
            { name: transactionsTableColumnNames[4], type: 'BIGINT', extra: 'NOT NULL' },
        ],
        permissions: [
            { role: consumerRole, permissions: ['SELECT', 'INSERT'] },
            { role: statementCreatorRole, permissions: ['SELECT'] }
        ],
        foreignKeys: [
            { column: transactionsTableColumnNames[3], references: `${usersTable.name}(${usersTable.columns[0].name})` },
            { column: transactionsTableColumnNames[4], references: `${usersTable.name}(${usersTable.columns[0].name})` }
        ],
        procedures: [ Procedures.INSERT_CONFLICT_AWARE ],
    }

 const transactionResultsTable: TableDescription ={
        name: `${schema}.transaction_results`, columns: [
            { name: transactionsTable.columns[0].name, type: 'BIGINT' , extra: 'PRIMARY KEY' },
            { name: 'DateProcessed', type: 'DATETIME' },
            { name: 'State', type: 'TINYINT' }
        ], permissions: [
            { role: consumerRole, permissions: ['SELECT', 'INSERT'] },
            { role: statementCreatorRole, permissions: ['SELECT'] }
        ],
        procedures: [ Procedures.INSERT_CONFLICT_AWARE ],
    }


const transactionsByUserTable: TableDescription = {
        name: `${schema}.transactions_by_user`, columns: [
            { name: 'UserId', type: 'BIGINT', extra: 'NOT NULL' },
            { name: 'Date', type: 'DATETIME', extra: 'NOT NULL' },
            { name: transactionsTable.columns[0].name, type: 'BIGINT' }
        ], permissions: [
            { role: consumerRole, permissions: ['SELECT', 'INSERT'] },
            { role: statementCreatorRole, permissions: ['SELECT'] }
        ],
        foreignKeys: [
            { column: 'UserId', references: `${usersTable.name}(${usersTable.columns[0].name})` },
            { column: transactionsTable.columns[0].name, references: 
                `${transactionsTable.name}(${transactionsTable.columns[0].name})` }
        ],
        nonClusteredIndexes: [
            {
                name: 'idx_c_transactionsByUser',
                columns: ['UserId', 'Date'],
                include: [transactionsTable.columns[0].name]
            }
        ],
        procedures: [ Procedures.INSERT ],
    }


const kafkaOffsetTable: TableDescription = {
        name: `${schema}.kafka_offsets`, columns: [
            { name: 'Groupid', type: 'NVARCHAR(18)', extra: 'NOT NULL' },
            { name: 'Topic', type: 'NVARCHAR(100)', extra: 'NOT NULL' },
            { name: 'Partition', type: 'INT', extra: 'NOT NULL' },
            { name: 'Offset', type: 'NVARCHAR(18)', extra: 'NOT NULL' }
        ], permissions: [
            { role: consumerRole, permissions: ['SELECT', 'INSERT', 'UPDATE'] }
        ],
        primaryKey: ['Groupid', 'Topic', 'Partition'],
        procedures: [ Procedures.UPSERT ],
    }

const rawDataTable: TableDescription = {
        name: `${schema}.raw_data`, columns: [
            { name: 'date', type: 'DATETIME', extra: 'NOT NULL' },
            { name: 'data', type: 'NVARCHAR(max)', extra: 'NOT NULL' }
        ], permissions: [
            { role: consumerRole, permissions: ['INSERT'] }
        ],
        procedures: [ Procedures.INSERT ],
    }


function procedureName(tableName: string, procedure: Procedures): string {
    return `${tableName}_${procedure}`;
}

function columnsToString(columns: ColumnDescription[]): string {
    return columns.map(c => `${c.name} ${c.type}${c.extra ? ' '+ c.extra : ''}`).join(',\n');
}
function columnsToProcedureTypes(columns: ColumnDescription[]): string {
    return columns.map(c => `@${c.name} ${c.type}`).join(',\n');
}
// function columnsToProcedureInputs(columns: ColumnDescription[]): string {
//     return columns.map(c => `@${c.name}`).join(', ');
// }
function fullColumnName(tableName: string, c: ColumnDescription): string {
    return `${tableName}.${c.name}`;
}
function procParameterName(name: string): string {
    return `@${name.replace(/\./g, '_')}`;
}

function columnsToProcedureInputs(table: TableDescription, start: number = 0, end?: number): string {
    return table.columns.slice(start, end).map((_, idx) => 
        procParameterName(fullColumnName(table.name, table.columns[idx]))).join(', ');
}
function columnsToValues(columns: ColumnDescription[]): string {
    return columns.map(c => `${c.name}`).join(', ');
}
function columnsToFullNameList(table: TableDescription): string {
    return table.columns.map((c,) => fullColumnName(table.name, c)).join(', ');
}
function columtEqArg(c: ColumnDescription) {
    return `${c.name} = @${c.name}`;
}
function compareColumnsToArgs (c: ColumnDescription[]) {
    return c.map(columtEqArg).join(' AND ');
}

function procedureQuery(procedureName: string, tableName: string, columns: ColumnDescription[], tail: string): string {
    return `CREATE PROCEDURE ${procedureName}
        ${columns.map(c => `${procParameterName(fullColumnName(tableName, c))} ${c.type}`).join(',\n')}
        AS
        SET NOCOUNT ON;
        ${tail}`;
}
function fullColumnNameEqItsProcArg(tableName: string, c: ColumnDescription): string {
    const fullName = fullColumnName(tableName, c);
    return `${fullName} = ${procParameterName(fullName)}`;
}
function fullColumnNamesEqItsProcArgs(tableName: string, c: ColumnDescription[], sep: string = ', '): string {
    return c.map(col => fullColumnNameEqItsProcArg(tableName, col)).join(sep);
}
function updateQuery(tableName: string, updatedColumn: ColumnDescription[], lookedUpColumns: ColumnDescription[]): string {
    return `UPDATE ${tableName}
            SET  ${fullColumnNamesEqItsProcArgs(tableName, updatedColumn)}
            WHERE (${fullColumnNamesEqItsProcArgs(tableName, lookedUpColumns, ' AND ')})`
}
function insertQuery(table: TableDescription): string {
    return `INSERT INTO ${table.name} (${columnsToValues(table.columns)})
            VALUES (${columnsToProcedureInputs(table)});`
}
function ifExistsQuery(tableName: string, lookedUpColumns: ColumnDescription[]): string {
    return `EXISTS (SELECT 1
            FROM ${tableName}
            WHERE ${fullColumnNamesEqItsProcArgs(tableName, lookedUpColumns, ' AND ')})`;
}
const tempNameT = "#t1"
function makeTempTableForTransactions(): string {
    return `SELECT TOP 0 * INTO ${tempNameT} FROM ${transactionsTable.name};
`;
}
function makeTempTableForTransactionResults(): string {
    return `SELECT TOP 0 * INTO ${tempNameT} FROM ${transactionResultsTable.name};
`;
}
// const addTransactionProcedure = `${schema}.addTransactionRecord`;
// const addUserProcedure = `${schema}.addUser`;
// const updateTransactionStatusProcedure = `${schema}.updateTransactionStatus`;
// const addTransactionByUserProcedure = `${schema}.addTransactionByUser`;
// const addKafkaOffsetProcedure = `${schema}.addKafkaOffset`;
// const addRawProcedure = `${schema}.addRaw`;

const uberProc = `${schema}.uberProcedure`;

const tt = `tt`
const tr = `tr`
export async function createSchema() {

    console.log(`========3 procedures1`);
    try {
        const pool = await connectToDatabase(user_sa);

    console.log(`========33 procedures1`);
        console.log(` ${JSON.stringify(await runQuery(pool, `select DB_ID('${database}')`))}`)
        console.log(` ${JSON.stringify(await runQuery(pool, `select user_name()`))}`)
        // console.log(` ${JSON.stringify(await runQuery(pool, `SELECT * FROM sys.dm_exec_sessions `))}`)
        
        await runQuery(pool, `IF DB_ID('${database}') IS not NULL
                drop database [${database}];
        `)

        console.log(`========4 procedures1`);
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
        
        console.log(`========2 procedures1`);
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
                ${columnsToString(table.columns)}
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
            // for (const proc of table.procedures || []) {
            //     const procName = procedureName(table.name, proc);
            // }
        }

        console.log(`========1 procedures1`);
        // // test tables
        await runQuery(pool, `select top 0 * into ${tt} from ${transactionsTable.name}`);
        await runQuery(pool, `select top 0 * into ${tr} from ${transactionResultsTable.name}`);
        await runQuery(pool, `GRANT INSERT ON ${tt} TO ${consumerRole};`);
        await runQuery(pool, `GRANT INSERT ON ${tr} TO ${consumerRole};`);

        console.log(`Creating procedures`);
        
        const tIdColumnName = transactionsTable.columns[0].name;
        await runQuery(pool, procedureQuery(uberProc, kafkaOffsetTable.name, [],`
            with allUsers as (select distinct ${transactionsTable.columns[3].name} as id
                                from #${tt}
                                union
                                select distinct ${transactionsTable.columns[4].name} as id
                                from #${tt}),
            usersFrom as (select distinct id from allUsers),
            namedUFrom as (select id,
                                'User' + CAST(id AS NVARCHAR) as Name
                            from usersFrom)

            insert into ${usersTable.name}
            select id as ${usersTable.columns[0].name}, Name as ${usersTable.columns[1].name}
            from namedUFrom
            where not exists (select 1 from ${usersTable.name}
                                where ${usersTable.columns[0].name} = namedUFrom.id);

            
            BEGIN TRY
                INSERT INTO ${transactionsTable.name}
                SELECT ${transactionsTable.columns.map(c => c.name).join(',')} FROM #${tt};
            END TRY
            BEGIN CATCH
                CREATE NONCLUSTERED INDEX temp_idx1 ON #${tt}(${tIdColumnName}, iddx);
                with rowNumberd as (select *, 
                                            ROW_NUMBER() over (partition by ${tIdColumnName} order by iddx) as rowNum
                                from #${tt}),
                marked as (select t2.${tIdColumnName} as t2sid, t3.*
                            from rowNumberd as t3
                            left join ${transactionsTable.name} as t2
                            on t2.${tIdColumnName} = t3.${tIdColumnName})
                select * into #marked${tt} from marked;
            
                CREATE NONCLUSTERED INDEX temp_idx2 ON #marked${tt}(t2sid, rowNum, iddx);
                CREATE NONCLUSTERED INDEX temp_idx3 ON #marked${tt}(rowNum);

                with distinctNew as (select * from #marked${tt}
                                    where t2sid is null and rowNum = 1)

                select * into #distinctNew from distinctNew;

                insert into ${transactionsTable.name} select ${transactionsTable.columns.map(c => `${c.name}`).join(', ')}
                from #distinctNew;
                select * from ${transactionsTable.name}
                
            END CATCH;
        `));

        console.log(`Creating procedures1`);
        
        for (const user of users) {
            await runQuery(pool, `CREATE LOGIN ${user.login} WITH PASSWORD = '${demo_password}'`)
            await runQuery(pool, `CREATE USER ${user.name} FOR LOGIN ${user.login}`);
        }

        await runQuery(pool,`ALTER ROLE ${statementCreatorRole} ADD MEMBER ${statementUser.name};`);
        await runQuery(pool,`ALTER ROLE ${consumerRole} ADD MEMBER ${consumerUser.name};`);
        
        await runQuery(pool, `GRANT EXECUTE ON ${uberProc} TO ${consumerRole};`);
    } catch (e) {
        console.error(`Error creating schema: ${e}`);
        throw e;
    }
}

export class Offsets {
    static create(gropuId: string, queryResult: sql.IResult<any>): Offsets {
        try {
            const mapping = new Map<string, string>();
            if (queryResult.recordset.length == 0 ||
                queryResult.recordset.filter(r => typeof r !== 'object').length != 0
            ) {
                return new Offsets(mapping);
            }
            console.log(`-- step 1 Creating Offsets from query result: ${JSON.stringify(queryResult.recordset)}`);
            console.log(`-- step 2 Creating Offsets from query result: ${JSON.stringify(queryResult.recordset.filter(r => r[kafkaOffsetTable.columns[0].name] == gropuId))}`);
            queryResult.recordset.filter(r => r[kafkaOffsetTable.columns[0].name] == gropuId).forEach(row => {
                mapping.set(`${row[kafkaOffsetTable.columns[1].name]}-${row[kafkaOffsetTable.columns[2].name]}`,
                    row[kafkaOffsetTable.columns[3].name]);
            });
            return new Offsets(mapping);
        } catch (e) {
            logger.error(`Error creating Offsets from query result ${JSON.stringify(queryResult.recordsets)}: ${e}`);
            throw e;
        }
    }
    static empty(): Offsets {
        return new Offsets(new Map<string, string>());
    }
    private constructor(private mapping: Map<string, string>) {
    }
    getOffset(topic: string, partition: number = 0): string | undefined {
        return this.mapping.get(`${topic}-${partition}`);
    }
}

export enum ConnectionErrorType {
    TRANSACRION_ERROR,
    QUERY_ERROR,
}
export class ConnectionError extends Error {
    constructor(public message: string, 
                public type: ConnectionErrorType) {
        super(message);
    }
}
export class UserConnection {
    static async create(): Promise<UserConnection> {
        const pool = await connectToDatabase(consumerUser.login, database);
        return new UserConnection(pool);
    }
    private constructor(private pool: sql.ConnectionPool) {
    }
    isConnectionAlive(): boolean {
        return this.pool.connected;
    }
    pidx = 0;
    async writeTransactionAndOffsetTransactionally(
        record: TransactionMessages,
        groupId: string,
        offset: string,
        partition: number,
        topic: string
    ): Promise<void> {
        const transaction = new sql.Transaction(this.pool)
        let request1: sql.Request | undefined = undefined;
        console.log(`stp 11 start`)
        try {
            request1 = await (await transaction.begin()).request();
            
        } catch (e) {
            const error = new ConnectionError(`Failed to start transaction: ${e}`, ConnectionErrorType.TRANSACRION_ERROR);
            logger.error(error.message);
            throw error;
        }
        console.log(`stp 112 ${JSON.stringify((await request1.batch(`select @@spid`)).recordset)}`);
        await request1.batch(`create table #${tt} (iddx int identity(1,1) primary key, 
            ${transactionsTable.columns.map(c => `${c.name} ${c.type}`).join(', ')})`);
        // if (record.r.length > 10000) {// set number from config?
        //     await request1.batch(`CREATE NONCLUSTERED INDEX idx_tt_id ON #${tt} (${transactionsTable.columns[0].name});`);
        // }
        await request1.batch(`select top 0 * into #${tr} from ${transactionResultsTable.name}`);
        await request1.batch(`select top 0 * into #off from ${kafkaOffsetTable.name}`);
        let error: ConnectionError | undefined = undefined;
        try {
            // TODO: see how to batch/prepare this
            /*  Making long non-atomic transactions is prone to race conditions, when multiple agents
                are updating the same data.
                Here it is assumed that Kafka partitions are sharded by user ID (or another unique key). 
                This guarantees no key overlap, enabling safe parallel writes.
                No locking is used.
                And this assumption is enforced by Kafka, because only one consumer may
                read from a single partition at a time.
            */
            // await this.pool.connect();
            if (record.type == "t") {
                console.log(`stp 13`)
                for (let i = 0; i < record.r.length; i++) {
                    const r = record.r[i];
                    // await this.addUserRecord(r.userIdFrom, `User ${r.userIdFrom}`);
                    // await this.addUserRecord(r.userIdTo, `User ${r.userIdTo}`);
                    await this.addTransactionRecord(r,  request1!);
                    // await this.addTransactionByUserRecord(r.userIdFrom, r.dateTime, r.id);
                    // await this.addTransactionByUserRecord(r.userIdTo, r.dateTime, r.id);
                }
            } else if (record.type == "r") {
                // await runQuery(this.pool, makeTempTableForTransactionResults())
                for (const rec of record.r) {
                    await this.updateTransactionStatus(rec.transactionID, rec.dateTime, rec.state, request1!);
                }
            } else if (record.type == "e") {
                const now = new Date();
                for (const rec of record.r) {
                    await this.saveRawData(now, rec,  request1!);
                }
            }

            const request = request1!
            console.log(`-- step 3 Writing offset for groupId ${procParameterName(fullColumnName(kafkaOffsetTable.name, kafkaOffsetTable.columns[0]))}, topic ${topic}, partition ${partition}, offset ${offset}`);
            await this.commitOffset(groupId, offset, topic, partition, request)
            console.log(`-- step 3.5 Written offset`)
            const r = await request.batch(`exec ${uberProc}`);
            // const r = await request1!.batch(`select * from #${tt}`)
            console.log(`-- step 4 Writing transaction records: ${JSON.stringify(r.recordset)}`);
            await request.batch(`DROP TABLE #${tt}`);
            await request.batch(`DROP TABLE #${tr}`);
            await request.batch(`DROP TABLE #off`);
            await transaction.commit()
        } catch (e) {
            console.log(`-- step 7`);
            error = new ConnectionError(`Failed to write transaction: ${e}`, ConnectionErrorType.QUERY_ERROR);
            logger.error(error.message);
        }
        console.log(`-- step 5`);
        if (error === undefined) {
            return;
        }
        console.log(`-- step 6`);
        try {
            await transaction.rollback()
        } catch (e) {
            const rollbackError = `Failed to rollback transaction: ${e}`;
            error.message += `\n${rollbackError}`;
            error.type = ConnectionErrorType.TRANSACRION_ERROR;
            logger.error(rollbackError);
        }
        throw error;
    }

    async addTransactionRecord(record: Transaction, request: sql.Request): Promise<void> {
        // if (!request) {
        //     request = this.pool.request();
        // }
        let quer
        try {
            const placeholders = transactionsTable.columns.map((_, i) => `p${this.pidx++}`);
            request.input(placeholders[0], sql.BigInt, record.id)
            request.input(placeholders[1], sql.DateTime, new Date(record.dateTime).toISOString())
            request.input(placeholders[2], sql.Decimal(18, 2), record.amount)
            request.input(placeholders[3], sql.BigInt, record.userIdFrom)
            request.input(placeholders[4], sql.BigInt, record.userIdTo)
            quer = `INSERT INTO #${tt} (${transactionsTable.columns.map(c => c.name).join(',')})
                VALUES (${placeholders.map(p => `@${p}`).join(',')});`
            await request.batch(quer);
                // await runQuery(this.pool, quer);
            // await request.execute(addTransactionProcedure);
        } catch (e) {
            throw `Failed to add transaction record ${JSON.stringify(record)} query ${quer}: ${e}`
        }
    }
    async commitOffset(groupId: string, offset: string, topic: string, partition: number, request: sql.Request): Promise<void> {
        let quer
        const placeholders = kafkaOffsetTable.columns.map((_, i) => `p${this.pidx++}`);
        request.input(placeholders[0], sql.BigInt, groupId)
        request.input(placeholders[1], sql.NVarChar(100), topic)
        request.input(placeholders[2], sql.Int, partition)
        request.input(placeholders[3], sql.NVarChar(18), offset)
        quer = `INSERT INTO #off (${columnsToFullNameList(kafkaOffsetTable)})
        VALUES (${placeholders.map(p => `@${p}`).join(',')});`
        await request!.batch(quer);
        // await request.execute(addKafkaOffsetProcedure);
    }
    async addTransactionByUserRecord(userId: number, dateTime: number, statementId: number) {
        const request = this.pool.request()
        try {
            request.input(transactionResultsTable.columns[0].name, sql.BigInt, userId)
            request.input(transactionResultsTable.columns[1].name, sql.DateTime, new Date(dateTime).toISOString())
            request.input(transactionResultsTable.columns[2].name, sql.BigInt, statementId) 
            // await runQuery(this.pool, `INSERT INTO ${transactionsByUserTable.name}Test (${columnsToFullNameList(transactionsByUserTable)})
            //     VALUES (${columnsToProcedureInputs(transactionsByUserTable)});`);
            // await request.execute(addTransactionByUserProcedure);
        } catch (e) {
            console.error(`Failed to add transaction by user record for userId ${userId}
                dateTime ${dateTime} and statementId ${statementId}: ${e}`);
            throw e;
        }
    }
    async addUserRecord(id: number, name: string) {
        const request = this.pool.request()
        // request.input(userColumns[0].name, sql.BigInt, id)
        // request.input(userColumns[1].name, sql.NVarChar(100), name)
        // await request.execute(addUserProcedure);
    }
    async updateTransactionStatus(transactionId: number, dateTime: number, state: TResult, request: sql.Request): Promise<void> {
        // const request = this.pool.request()
        request.input(transactionResultsTable.columns[0].name, sql.BigInt, transactionId)
        request.input(transactionResultsTable.columns[1].name, sql.DateTime, dateTime)
        request.input(transactionResultsTable.columns[2].name, sql.TinyInt, state)
        request.batch(`INSERT INTO #${tr}
            (${columnsToFullNameList(transactionResultsTable)})
            VALUES (${columnsToProcedureInputs(transactionResultsTable)});`);
        // await request.execute(updateTransactionStatusProcedure);
    }
    async getOffsets(groupId: string, topics: KConsumerOffsetInfo[]): Promise<Offsets> {
        const request = this.pool.request()
        // building a "select * from 'table' where 'group...' AND ((topic1 + partitins1) OR (topic2 + partitions2) OR ...)" query
        const selectFromOffsets = `SELECT * FROM ${kafkaOffsetTable.name} `

        const whereGroupIsArg = `WHERE ${columtEqArg(kafkaOffsetTable.columns[0])}`
        request.input(kafkaOffsetTable.columns[0].name, sql.NVarChar(18), groupId)
        const partitionsPerTopics = `${topics.map((topic, t_idx) => {
            //topic = @topic
            const tParamName = kafkaOffsetTable.columns[1].name + `${t_idx}`;
            request.input(tParamName, sql.NVarChar(100), topic.topic)
            const topicEqualsParam: string = ` ${kafkaOffsetTable.columns[1].name} = @${tParamName}`;
            //partition IN (@pt11, @pt12, ...)
            const parameterRange: string = `${topic.partitions.map((partition, p_idx) => {
                const pParamName = `pt${t_idx}${p_idx}`;
                request.input(pParamName, sql.Int, partition);
                return `@${pParamName}`;
            }).join(',')}`;
            return `(${topicEqualsParam} AND ${kafkaOffsetTable.columns[2].name} IN (${parameterRange}))`;
        }).join(` OR `)}`;

        const query = `${selectFromOffsets} ${whereGroupIsArg} AND (${partitionsPerTopics})`;
        logger.debug(`Running query to get offsets: ${query}`);
        let result;
        try {
            result = await request.query(query);
        } catch (e) {
            logger.error(`Error running query ${query} for ${JSON.stringify(topics)}: ${e}`);
            throw e;
        }

        logger.debug(`got offsets: ${JSON.stringify(result)}`);
        return Offsets.create(groupId, result);
    }
    async saveRawData(date: Date, data: string, request: sql.Request): Promise<void> {
        const placeholders = transactionsTable.columns.map((_, i) => `p${this.pidx++}`);
        request.input(placeholders[0], sql.DateTime, date);
        request.input(placeholders[1], sql.NVarChar(sql.MAX), data);
        await request.batch(`INSERT INTO ${rawDataTable.name} (${columnsToFullNameList(rawDataTable)})
            VALUES (${placeholders.map(p => `@${p}`)});`);
        // await request.execute(addRawProcedure);
    }
    async runQuery(query: string): Promise<sql.IResult<any>> {
        const request = this.pool.request();
        try {
            return await request.query(query);
        } catch (e) {
            logger.error(`Error running query ${query}: ${e}`);
            throw e;
        }
    }
    async getTransactions(): Promise<Transaction[]> {
        const request = this.pool.request();
        try {
            const result = await request.query(`SELECT * FROM ${transactionsTable.name}`);
            return transactions(result);
        } catch (e) {
            logger.error(`Error getting transactions: ${e}`);
            throw e;
        }
    }
    async getRawData(): Promise<{date: Date, data: string}[]> {
        const request = this.pool.request();
        try {
            const result = await request.query(`SELECT * FROM ${rawDataTable.name}`);
            return result.recordset.map(r => ({
                date: new Date(r.date),
                data: r.data
            }));
        } catch (e) {
            logger.error(`Error getting raw data: ${e}`);
            throw e;
        }
    }
    close(): Promise<void> {
        return this.pool.close();
    }
}
 
function transactions(sqlRes: sql.IResult<any>): Transaction[] {
    if (!sqlRes || !sqlRes.recordset || sqlRes.recordset.length === 0) {
        return [];
    }
    return sqlRes.recordset.map(r => {
        return TransactionValidator.parse({
            id: Number(r['id']), 
            amount: Number(r['amount']), 
            dateTime: new Date(r['dateTime']).getMilliseconds(),
            userIdFrom: Number(r['userIdFrom']),
            userIdTo: Number(r['userIdTo'])});
    });
}
