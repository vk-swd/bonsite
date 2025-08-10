import { Metadata, MetadataValidator, Transaction, TransactionMessages, TransactionResult, TransactionValidator, TResult } from './event_types.js'
import { getEnv, KConsumerOffsetInfo, last } from './utils.js'

import sql from 'mssql'
import { logger } from './logger.js'

const user_sa = getEnv('MSSQL_SA_USERNAME')
const demo_password = getEnv('MSSQL_PASSWORD')
const database = getEnv('MSSQL_DB_NAME')
const server = getEnv('MSSQL_HOSTNAME')
const user_consumer = getEnv('MSSQL_CONSUMER_USERNAME')
const user_statement_creator = getEnv('MSSQL_STATEMENT_CREATOR_USERNAME')


const roles = [`${user_consumer}_role`, `${user_statement_creator}_role`, `test_role`];
const [consumerRole,  statementCreatorRole, testRole] = roles
const users: {name: string, login: string}[] = [
    {name: `${user_consumer}_user`, login: `${user_consumer}_login`},
    {name: `${user_statement_creator}_user`, login: `${user_statement_creator}_login`},
    {name: `${testRole}_user`, login: `${testRole}_login`}]
const [consumerUser, statementUser, testUser] = users


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

type ValueWithMeta = { name: string, type: string, extra?: string }
type Transformed<T> = {
  [K in keyof T]: ValueWithMeta
}


type TableDescription<T> = {
    name: string;
    columns: Transformed<T>;
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
type MetadataSerialized = {
    metadata: string;
}

const [tc_id, tc_date, tc_amount, tc_uFrom, tc_uTo] = Object.keys(TransactionValidator.shape);
type TransactionStored = MetadataSerialized & Transaction;
type TransactionResultStored = MetadataSerialized & TransactionResult;

const usersTable: TableDescription<{id: "", name:""}> = {
    name: `${schema}.users`, columns: {
        id: { name: 'id', type: 'BIGINT', extra: 'PRIMARY KEY' }, //IDENTITY(1,1)
        name: { name: 'Name', type: 'NVARCHAR(100)', extra: 'NOT NULL' }
    }, permissions: [
        { role: consumerRole, permissions: ['SELECT', 'INSERT'] },
        { role: statementCreatorRole, permissions: ['SELECT'] }
    ],
    procedures: [ Procedures.INSERT_IF_NOT_EXISTS ],
}

const transactionsTable: TableDescription<TransactionStored> = {
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

const transactionResultsTable: TableDescription<TransactionResultStored> ={
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


const transactionsByUserTable: TableDescription<{idx:"", userId:"", date: "", transId: ""}> = {
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

const kafkaOffsetTable: TableDescription<{groupId: "", topic:"", partition:"",offset:""}> = {
    name: `${schema}.kafka_offsets`, columns: {
        groupId: { name: 'Groupid', type: 'NVARCHAR(18)', extra: 'NOT NULL' },
        topic: { name: 'Topic', type: 'NVARCHAR(100)', extra: 'NOT NULL' },
        partition: { name: 'Partition', type: 'INT', extra: 'NOT NULL' },
        offset: { name: 'Offset', type: 'NVARCHAR(18)', extra: 'NOT NULL' }
    }, permissions: [
        { role: consumerRole, permissions: ['SELECT', 'INSERT', 'UPDATE'] }
    ],
    primaryKey: ['Groupid', 'Topic', 'Partition']
}

const rawDataTable: TableDescription<{idx: "", data: ""}> = {
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


const typeToSqlFactoryType = new Map<string, sql.ISqlType>([
    ['BIGINT', { type: sql.BigInt }],
    ['DATETIME', { type: sql.DateTime }],
    ['DECIMAL(18,2)', { type: sql.Decimal(18, 2) }],
    ['NVARCHAR(100)', { type: sql.NVarChar(100) }],
    ['TINYINT', { type: sql.TinyInt }]
]);

function columnsToString(columns: ColumnDescription[]): string {
    return columns.map(c => `${c.name} ${c.type}${c.extra ? ' '+ c.extra : ''}`).join(',\n');
}
function fullColumnName(tableName: string, c: ColumnDescription): string {
    return `${tableName}.${c.name}`;
}
function procParameterName(name: string): string {
    return `@${name.replace(/\./g, '_')}`;
}
function columnsToProcedureInputs<T>(table: TableDescription<T>, start: number = 0, end?: number): string {
    const columns = Object.values(table.columns).slice(start, end);
    return columns.map((_, idx) => 
        procParameterName(fullColumnName(table.name, columns[idx] as ColumnDescription))).join(', ');
}
function columnsToValues(columns: ColumnDescription[]): string {
    return columns.map(c => `${c.name}`).join(', ');
}
function columnsToFullNameList<T>(table: TableDescription<T>): string {
    return Object.values(table.columns).map((c,) => fullColumnName(table.name, c as ColumnDescription)).join(', ');
}
function columtEqArg(c: ColumnDescription) {
    return `${c.name} = @${c.name}`;
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
function insertQuery<T>(table: TableDescription<T>): string {
    return `INSERT INTO ${table.name} (${columnsToValues(Object.values(table.columns))})
            VALUES (${columnsToProcedureInputs(table)});`
}
function ifExistsQuery(tableName: string, lookedUpColumns: ColumnDescription[]): string {
    return `EXISTS (SELECT 1
            FROM ${tableName}
            WHERE ${fullColumnNamesEqItsProcArgs(tableName, lookedUpColumns, ' AND ')})`;
}

const addKafkaOffsetProcedure = `${schema}.addKafkaOffset`;

const uberProc = `${schema}.uberProcedure`;
const resProc = `${schema}.resultProcedure`;
const resultStruct = ["duds", "newCount"];
const [duds, newCount] = resultStruct;
const tt = `tt`

function generateRecordInsertProc<T>(table: TableDescription<T>): string {
    const isTransactionsTable = table.name == transactionsTable.name;
    const tIdColumn = isTransactionsTable ? transactionsTable.columns.id : transactionResultsTable.columns.id;
    let result: string = '';
    if (isTransactionsTable) {
        result += `with allUsers as (select distinct ${tc_uFrom} as id
                        from #${tt}
                        union
                        select distinct ${tc_uTo} as id
                        from #${tt}),
        usersFrom as (select distinct id from allUsers),
        namedUFrom as (select id,
                            'User' + CAST(id AS NVARCHAR) as Name
                        from usersFrom)

        insert into ${usersTable.name}
        select id as ${usersTable.columns.id.name}, Name as ${usersTable.columns.name.name}
        from namedUFrom
        where not exists (select 1 from ${usersTable.name}
                            where ${usersTable.columns.id.name} = namedUFrom.id);
        ` 
    }
    result += `
        declare @${newCount} int;
        declare @${duds} int;
        set @${duds} = 0;
        BEGIN TRY
            INSERT INTO ${table.name}
            SELECT ${(Object.values(table.columns) as ValueWithMeta[]).map(c  => c.name).join(',')} FROM #${tt};
            set @${newCount} = @@ROWCOUNT;
        END TRY
        BEGIN CATCH
            CREATE NONCLUSTERED INDEX temp_idx ON #${tt}(${tIdColumn.name}, iddx);
            with rowNumberd as (select *, 
                                ROW_NUMBER() over (partition by ${tIdColumn.name} order by iddx) as rowNum
                                from #${tt}),
            marked as (select t2.${tIdColumn.name} as t2sid, t3.*
                        from rowNumberd as t3
                        left join ${table.name} as t2
                        on t2.${tIdColumn.name} = t3.${tIdColumn.name})
                select * into #marked${tt} from marked;
        
            CREATE NONCLUSTERED INDEX temp_idx2 ON #marked${tt}(t2sid, rowNum, iddx);
            CREATE NONCLUSTERED INDEX temp_idx3 ON #marked${tt}(rowNum);

            with distinctNew as (select * from #marked${tt}
                                where t2sid is null and rowNum = 1)
                select * into #distinctNew from distinctNew;
                
            insert into ${table.name} 
                select ${(Object.values(table.columns) as ValueWithMeta[]).map(c  => c.name).join(',')}
                from #distinctNew;

            set @${newCount} = @@ROWCOUNT;

            with nonDistinct as (select * from #marked${tt}
                                where t2sid is not null or rowNum > 1
                                ),
            jsonned as (SELECT data
                        FROM nonDistinct AS t
                        CROSS APPLY (
                            SELECT ${(Object.values(table.columns) as ValueWithMeta[]).map(c  => `t.${c.name} as ${c.name}`).join(',')}
                            FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
                        ) AS derived(data))
                insert into ${rawDataTable.name} select * from jsonned;

            set @${duds} = @@ROWCOUNT;
        `
    if (table.name == transactionsTable.name) {
        result += `
        insert into ${transactionsByUserTable.name}
            select ${tc_uFrom}, ${tc_date}, ${tIdColumn.name} from #distinctNew
            union
            select ${tc_uTo}, ${tc_date}, ${tIdColumn.name} from #distinctNew
            where ${tc_uFrom} != ${tc_uTo};
        `;
    }
    result += `
    END CATCH;
    select @${duds} as ${duds}, @${newCount} as ${newCount};`

    return result;      
};

class GetTransactionsProc {
    public dateTo = {...transactionsByUserTable.columns.date, name: "DateTo"};
    public dateFrom = {...transactionsByUserTable.columns.date, name: "DateFrom"};
    public userId = transactionsByUserTable.columns.userId;
    public transId = transactionsByUserTable.columns.transId;
    public name = `${schema}.getTransactions`;
    
    getProcedureQuery(): string {
        return`
            CREATE PROCEDURE ${this.name}
            ${[this.userId, this.dateFrom, this.dateTo].map(t => `@${t.name} ${t.type}`).join(',\n')}
            AS
            SET NOCOUNT ON;
            with selectedIds as (SELECT tByUser.${transactionsByUserTable.columns.transId.name}
                                    FROM ${transactionsByUserTable.name} as tByUser
                                left join ${transactionResultsTable.name} as tr
                                    on tByUser.${transactionsByUserTable.columns.transId.name} = tr.${transactionResultsTable.columns.id.name}
                                WHERE ${transactionsByUserTable.columns.userId.name} = @${transactionsByUserTable.columns.userId.name} 
                                    AND ${transactionsByUserTable.columns.date.name} BETWEEN @${this.dateFrom.name} AND @${this.dateTo.name}
                                    and tr.${transactionResultsTable.columns.state.name} = ${TResult.CONFIRMED})
                SELECT * FROM ${transactionsTable.name} 
                WHERE ${transactionsTable.columns.id.name} IN (
                SELECT ${transactionsByUserTable.columns.transId.name} FROM selectedIds);
        `}
}
const procGetTransactions = new GetTransactionsProc();
class GetRawDataRecordsProc {
    public lastCountArg = "lastCount";
    public name = `${schema}.getRawDataRecords`;
    getProcedureQuery(): string {
        return `
            CREATE PROCEDURE ${this.name}
            @${this.lastCountArg} BIGINT
            AS
            SET NOCOUNT ON;
            with topItems as (SELECT top (@${this.lastCountArg}) * 
                            FROM ${rawDataTable.name} 
                            order by ${rawDataTable.columns.idx.name} DESC)
            SELECT ${rawDataTable.columns.data.name} as data from topItems 
                    order by ${rawDataTable.columns.idx.name} ASC;
        `;
    }
}
const getRawDataRecordsProc = new GetRawDataRecordsProc();

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
        
        await runQuery(pool, 
            procedureQuery(addKafkaOffsetProcedure, kafkaOffsetTable.name, Object.values(kafkaOffsetTable.columns), `
                if ${ifExistsQuery(kafkaOffsetTable.name, Object.values(kafkaOffsetTable.columns).slice(0,-1))}
                    ${updateQuery(kafkaOffsetTable.name, [kafkaOffsetTable.columns.offset], Object.values(kafkaOffsetTable.columns).slice(0,-1))}
                else 
                    ${insertQuery(kafkaOffsetTable)}
            `)
        );

        
        await runQuery(pool, procedureQuery(uberProc, "", [],generateRecordInsertProc(transactionsTable)));
        await runQuery(pool, procedureQuery(resProc, "", [], generateRecordInsertProc(transactionResultsTable)));
        await runQuery(pool, procGetTransactions.getProcedureQuery());
        await runQuery(pool, getRawDataRecordsProc.getProcedureQuery());
        
        for (const user of users) {
            await runQuery(pool, `CREATE LOGIN ${user.login} WITH PASSWORD = '${demo_password}'`)
            await runQuery(pool, `CREATE USER ${user.name} FOR LOGIN ${user.login}`);
        }

        await runQuery(pool,`ALTER ROLE ${statementCreatorRole} ADD MEMBER ${statementUser.name};`);
        await runQuery(pool,`ALTER ROLE ${consumerRole} ADD MEMBER ${consumerUser.name};`);
        
        await runQuery(pool, `GRANT EXECUTE ON ${uberProc} TO ${consumerRole};`);
        await runQuery(pool, `GRANT EXECUTE ON ${resProc} TO ${consumerRole};`);
        await runQuery(pool, `GRANT EXECUTE ON ${procGetTransactions.name} TO ${consumerRole};`);
        await runQuery(pool, `GRANT EXECUTE ON ${addKafkaOffsetProcedure} TO ${consumerRole};`);
        await runQuery(pool, `GRANT EXECUTE ON ${getRawDataRecordsProc.name} TO ${consumerRole};`);
    } catch (e) {
        console.error(`Error creating schema: ${e}`);
        throw e;
    }
}

function setQueryInput<T>(request: sql.Request, column: ColumnDescription, value: T, arg?: string): void {
    request.input(arg ? arg : column.name, typeToSqlFactoryType.get(column.type)!, value);
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
            queryResult.recordset.filter(r => r[kafkaOffsetTable.columns.groupId.name] == gropuId).forEach(row => {
                mapping.set(`${row[kafkaOffsetTable.columns.topic.name]}-${row[kafkaOffsetTable.columns.partition.name]}`,
                    row[kafkaOffsetTable.columns.offset.name]);
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
    QUERY_ERROR
}
export class ConnectionError extends Error {
    constructor(public message: string, 
                public type: ConnectionErrorType,
                public readonly badCounter: number = 0) {
        super(message);
    }
}
export class QueryRes {
    duds: number = 0;
    newCount: number = 0;
    rolledBack: boolean = false;
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
    ): Promise<QueryRes> {

        const transaction = new sql.Transaction(this.pool)
        let request1: sql.Request | undefined = undefined;
        try {
            request1 = await (await transaction.begin()).request();
        } catch (e) {
            const error = new ConnectionError(`Failed to start transaction: ${e}`, ConnectionErrorType.TRANSACRION_ERROR);
            logger.error(error.message);
            throw error;
        }
        const result = new QueryRes();
        let error: ConnectionError | undefined = undefined;
        try {
            /*  Making long non-atomic transactions is prone to race conditions, when multiple agents
                are updating the same data.
                Here it is assumed that Kafka partitions are sharded by user ID (or another unique key). 
                This guarantees no key overlap, enabling safe parallel writes.
                No locking is used.
                And this assumption is enforced by Kafka, because only one consumer may
                read from a single partition at a time.
            */
            if (record.type == "t") {
                await request1.batch(`create table #${tt} (iddx int identity(1,1) primary key, 
                    ${Object.values(transactionsTable.columns).map(c => `${c.name} ${c.type}`).join(', ')})`);
                for (let i = 0; i < record.r.length; i++) {
                    const r = record.r[i];
                    await this.addTransactionRecord(r.payload as Transaction, JSON.stringify(r.metadata),  request1!);
                }
                const r = await request1.batch(`exec ${uberProc}`);
                result.duds = r.recordset[0][duds];
                result.newCount = r.recordset[0][newCount];
                await request1.batch(`DROP TABLE #${tt}`)
            } else if (record.type == "r") {
                await request1.batch(`create table #${tt} (iddx int identity(1,1) primary key, 
                    ${Object.values(transactionResultsTable.columns).map(c => `${c.name} ${c.type}`).join(', ')})`);
                for (const rec of record.r) {
                    await this.addTransactionResult(rec.payload as TransactionResult, JSON.stringify(rec.metadata), request1);
                }
                const r = await request1.batch(`exec ${resProc}`);
                result.duds = r.recordset[0][duds];
                result.newCount = r.recordset[0][newCount];
                await request1.batch(`DROP TABLE #${tt}`);
            } else if (record.type == "e") {
                for (const rec of record.r) {
                    await this.saveRawData(rec, request1!);
                }
            }
            await this.commitOffset(groupId, offset, topic, partition, request1);
            await transaction.commit()
        } catch (e) {
            error = new ConnectionError(`Failed to commit transaction: ${e}`, ConnectionErrorType.QUERY_ERROR);
            logger.error(error.message);
        }
        if (error === undefined) {
            return result;
        }
        try {
            await transaction.rollback()
            result.rolledBack = true;
        } catch (e) {
            const rollbackError = `Failed to rollback transaction: ${e}`;
            error.message += `\n${rollbackError}`;
            error.type = ConnectionErrorType.TRANSACRION_ERROR;
            logger.error(rollbackError);
            throw error;
        }
        return result;
    }

    async addTransactionRecord(record: Transaction, metadata: string, request: sql.Request): Promise<void> {
        let quer
        try {
            const columns = (Object.entries(transactionsTable.columns));
            const placeholders = columns.map((_, i) => `p${this.pidx++}`);
            request.input(placeholders[0], sql.BigInt, record.id)
            request.input(placeholders[1], sql.DateTime, new Date(record.dateTime).toISOString())
            request.input(placeholders[2], sql.Decimal(18, 2), record.amount)
            request.input(placeholders[3], sql.BigInt, record.userIdFrom)
            request.input(placeholders[4], sql.BigInt, record.userIdTo)
            request.input(placeholders[5], sql.NVarChar(sql.MAX), metadata)
            quer = `INSERT INTO #${tt} (${columns.map(c => c[1].name).join(',')})
                VALUES (${placeholders.map(p => `@${p}`).join(',')});`
            await request.batch(quer);
        } catch (e) {
            throw `Failed to add transaction record ${JSON.stringify(record)} query ${quer}: ${e}`
        }
    }
    async addTransactionResult(record: TransactionResult, metadata: string, request: sql.Request): Promise<void> {
        const columns = (Object.values(transactionResultsTable.columns) as ValueWithMeta[]);
        const placeholders = columns.map((c, i) => `${c.name}${this.pidx++}`);
        request.input(placeholders[0], sql.BigInt, record.id)
        request.input(placeholders[1], sql.DateTime, new Date(record.dateTime).toISOString())
        request.input(placeholders[2], sql.TinyInt, record.state)
        request.input(placeholders[3], sql.NVarChar(sql.MAX), metadata)
        await request.batch(`INSERT INTO #${tt}
            (${columnsToFullNameList(transactionResultsTable)})
            VALUES (${placeholders.map(p => `@${p}`).join(',')});`);
    }
    async commitOffset(groupId: string, offset: string, topic: string, partition: number, request: sql.Request): Promise<void> {
        const columns = (Object.values(kafkaOffsetTable.columns) as ValueWithMeta[]);
        const param = (columnIdx: number) => procParameterName(fullColumnName(kafkaOffsetTable.name, columns[columnIdx]));
        const placeholders = columns.map((_, i) => `commitOffset${this.pidx++}`);
        // [groupId, topic, partition, offset].forEach((value, idx) => {
        //     request.input(placeholders[idx], 
        //         typeToSqlFactoryType.get(columns[idx].type)!, value);
        // });
        request.input(placeholders[0], sql.BigInt, groupId)
        request.input(placeholders[1], sql.NVarChar(100), topic)
        request.input(placeholders[2], sql.Int, partition)
        request.input(placeholders[3], sql.NVarChar(18), offset)
        await request!.batch(`exec ${addKafkaOffsetProcedure} ${columns
            .map((_, i) => `${param(i)} = @${placeholders[i]}`).join(', ')};`);
    }
    async getOffsets(groupId: string, topics: KConsumerOffsetInfo[]): Promise<Offsets> {
        const request = this.pool.request()
        // building a "select * from 'table' where 'group...' AND ((topic1 + partitins1) OR (topic2 + partitions2) OR ...)" query
        const selectFromOffsets = `SELECT * FROM ${kafkaOffsetTable.name} `
        const whereGroupIsArg = `WHERE ${columtEqArg(kafkaOffsetTable.columns.groupId)}`
        request.input(kafkaOffsetTable.columns.groupId.name, sql.NVarChar(18), groupId)
        // Making "topic = @topic AND partition IN (@pt11, @pt12, ...)" for each topic
        const partitionsPerTopics = `${topics.map((topic, t_idx) => {
            //topic = @topic
            const tParamName = kafkaOffsetTable.columns.topic.name + `${t_idx}`;
            request.input(tParamName, sql.NVarChar(100), topic.topic)
            const topicEqualsParam: string = ` ${kafkaOffsetTable.columns.topic.name} = @${tParamName}`;
            //partition IN (@pt11, @pt12, ...)
            const parameterRange: string = `${topic.partitions.map((partition, p_idx) => {
                const pParamName = `pt${t_idx}${p_idx}`;
                request.input(pParamName, sql.Int, partition);
                return `@${pParamName}`;
            }).join(',')}`;
            return `(${topicEqualsParam} AND ${kafkaOffsetTable.columns.partition.name} IN (${parameterRange}))`;
        }).join(` OR `)}`;

        const query = `${selectFromOffsets} ${whereGroupIsArg} AND (${partitionsPerTopics})`;
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
    async saveRawData(data: string, request: sql.Request): Promise<void> {
        const placeholder = `p${this.pidx++}`;
        request.input(placeholder, sql.NVarChar(sql.MAX), data);
        await request.batch(`INSERT INTO ${rawDataTable.name} 
            (${rawDataTable.columns.data.name})
            VALUES (@${placeholder});`);
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
    async getTransactions(userId: number, dateRange?: {from: number, to: number}): Promise<Transaction[]> {
        const request = this.pool.request();
        try {
            setQueryInput(request, procGetTransactions.userId, userId);
            if (dateRange !== undefined) {
                setQueryInput(request, procGetTransactions.dateFrom, new Date(dateRange.from).toISOString());
                setQueryInput(request, procGetTransactions.dateTo, new Date(dateRange.to).toISOString());
            } else {
                setQueryInput(request, procGetTransactions.dateFrom, new Date(0).toISOString());
                setQueryInput(request, procGetTransactions.dateTo, new Date("9999-12-31T23:59:59.997Z").toISOString());
            }
            return await transactions(await request.execute(procGetTransactions.name));
        } catch (e) {
            logger.error(`Error getting transactions: ${e}`);
            throw e;
        }
    }
    async getRawData(count: number): Promise<string[]> {
        const request = this.pool.request();
        try {
            request.input(getRawDataRecordsProc.lastCountArg, sql.BigInt, count);
            const result = await request.execute(getRawDataRecordsProc.name);
            return result.recordset.map(r => r.data);
        } catch (e) {
            logger.error(`Error getting raw data: ${e}`);
            throw e;
        }
    }
    async streamTransactions(processor: (metadata: Metadata, userId?: number) => void): Promise<void> {
        const tables = [transactionsTable, transactionResultsTable,rawDataTable];
        for (const table of tables) {
            await new Promise<void>((resolve, reject) => {
                const request = this.pool.request();
                request.stream = true; // Enable streaming
                request.on('row', row => {
                    if (table.name == transactionsTable.name) {
                        processor(MetadataValidator.parse(JSON.parse(row.metadata)), row.userIdFrom);
                    } else if (table.name == transactionResultsTable.name) {
                        processor(MetadataValidator.parse(JSON.parse(row.metadata)), -1);
                    } else {
                        processor(MetadataValidator.parse(JSON.parse(JSON.parse(row.data).metadata)));
                    }
                })
                request.on('done', row => {
                    logger.debug(`Pausing stream: ${JSON.stringify(row)}`);
                    resolve();
                })
                request.query(`SELECT * FROM ${table.name}`);
            })
        }
    }
    close(): Promise<void> {
        return this.pool.close();
    }
}
function transaction(row: any) {
    return TransactionValidator.parse({
        id: parseInt(row.id),
        amount: parseInt(row.amount), 
        dateTime: (new Date(row.dateTime).getMilliseconds()),
        userIdFrom: parseInt(row.userIdFrom),
        userIdTo: parseInt(row.userIdTo)
    });
 }
function transactions(sqlRes: sql.IResult<any>): Transaction[] {
    if (!sqlRes || !sqlRes.recordset || sqlRes.recordset.length === 0) {
        return [];
    }
    return sqlRes.recordset.map(r => transaction(r));
}
