import { Transaction, TransactionResult, TResult } from "../event_types.js";
import { ColumnDescription, kafkaOffsetTable, rawDataTable, schema, TableDescription, transactionResultsTable, transactionsByUserTable, transactionsTable, Transformed, usersTable } from "./tables.js";
import * as sql from 'mssql'



const resultStruct = ["duds", "newCount"];
const [duds, newCount] = resultStruct;


const tResT = transactionResultsTable;
const tPerUserT = transactionsByUserTable;

class GetTransactionsProc {
    public dateTo = {...tPerUserT.columns.date, name: "DateTo"};
    public dateFrom = {...tPerUserT.columns.date, name: "DateFrom"};
    public userId = tPerUserT.columns.userId;
    public transId = tPerUserT.columns.transId;
    public name = `${schema}.getTransactions`;
    
    getProcedureQuery(): string {
        return`
            CREATE PROCEDURE ${this.name}
            ${[this.userId, this.dateFrom, this.dateTo].map(t => `@${t.name} ${t.type}`).join(',\n')}
            AS
            SET NOCOUNT ON;
            with selectedIds as (SELECT tByUser.${tPerUserT.columns.transId.name}
                                    FROM ${tPerUserT.name} as tByUser
                                left join ${tResT.name} as tr
                                    on tByUser.${tPerUserT.columns.transId.name} = tr.${tResT.columns.id.name}
                                WHERE ${tPerUserT.columns.userId.name} = @${tPerUserT.columns.userId.name} 
                                    AND ${tPerUserT.columns.date.name} BETWEEN @${this.dateFrom.name} AND @${this.dateTo.name}
                                    and tr.${tResT.columns.state.name} = ${TResult.CONFIRMED})
                SELECT * FROM ${transactionsTable.name} 
                WHERE ${transactionsTable.columns.id.name} IN (
                SELECT ${tPerUserT.columns.transId.name} FROM selectedIds);
        `}
}
export const procGetTransactions = new GetTransactionsProc();

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
export const getRawDataRecordsProc = new GetRawDataRecordsProc();
export function procParameterName(name: string): string {
    return `@${name.replace(/\./g, '_')}`;
}
export function fullColumnName(tableName: string, c: ColumnDescription): string {
    return `${c.name}`;
}
export function procedureQuery(procedureName: string, tableName: string, columns: ColumnDescription[], tail: string): string {
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
function ifExistsQuery(tableName: string, lookedUpColumns: ColumnDescription[]): string {
    return `EXISTS (SELECT 1
            FROM ${tableName}
            WHERE ${fullColumnNamesEqItsProcArgs(tableName, lookedUpColumns, ' AND ')})`;
}
function updateQuery(tableName: string, updatedColumn: ColumnDescription[], lookedUpColumns: ColumnDescription[]): string {
    return `UPDATE ${tableName}
            SET  ${fullColumnNamesEqItsProcArgs(tableName, updatedColumn)}
            WHERE (${fullColumnNamesEqItsProcArgs(tableName, lookedUpColumns, ' AND ')})`
}
function columnsToProcedureInputs<T>(table: TableDescription<T>, start: number = 0, end?: number): string {
    const columns = Object.values(table.columns).slice(start, end);
    return columns.map((_, idx) => 
        procParameterName(fullColumnName(table.name, columns[idx] as ColumnDescription))).join(', ');
}
function columnsToValues(columns: ColumnDescription[]): string {
    return columns.map(c => `${c.name}`).join(', ');
}
function insertQuery<T>(table: TableDescription<T>): string {
    return `INSERT INTO ${table.name} (${columnsToValues(Object.values(table.columns))})
            VALUES (${columnsToProcedureInputs(table)});`
}
class AddKafkaOffsetProcedure {
    public name = `${schema}.addKafkaOffset`;
    getProcedureQuery(): string {
        return procedureQuery(this.name, kafkaOffsetTable.name, Object.values(kafkaOffsetTable.columns), `
                if ${ifExistsQuery(kafkaOffsetTable.name, Object.values(kafkaOffsetTable.columns).slice(0,-1) as ColumnDescription[])}
                    ${updateQuery(kafkaOffsetTable.name, [kafkaOffsetTable.columns.offset], Object.values(kafkaOffsetTable.columns).slice(0,-1) as ColumnDescription[])}
                else 
                    ${insertQuery(kafkaOffsetTable)}
            `)
    }
}
export const addKafkaOffsetProcedure = new AddKafkaOffsetProcedure();

interface SProc {
    name: string;
    getProcedureQuery(): string;
}

class SetUpTempTableProc<T> implements SProc {
    public name: string;
    public tableName: string
    public dstTable: TableDescription<T>
    private insertionProc: SProc;
    constructor(srcTable: TableDescription<T>) {
        const tName = srcTable.name.replace(/\./g, '');
        this.tableName = `#${tName}`;
        this.name = `${schema}.create${tName}`;
        this.dstTable = {...srcTable, name: this.tableName};

        const insertionProcName = `${schema}.insertTo${tName}`;
        this.insertionProc = {
            name: insertionProcName,
            getProcedureQuery: () => procedureQuery(insertionProcName, 
                this.dstTable.name, Object.values(this.dstTable.columns), 
            insertQuery(this.dstTable))
        }
    }
    getProcedureQuery(): string {
        return ""
    }
    async batch(request: sql.Request): Promise<void> {
        await request.batch(`create table ${this.dstTable.name} (iddx int identity(1,1) primary key, 
                    ${(Object.values(this.dstTable.columns) as ColumnDescription[]).map(c => `${c.name} ${c.type}`).join(', ')})`)
    }
    async dropTable(request: sql.Request): Promise<void> {
        await request.batch(`DROP TABLE IF EXISTS ${this.dstTable.name}`);
    }
    getInsertionProcedure(): SProc {
        return this.insertionProc;
    }
}
export const setUpTempTransactionsTable = new SetUpTempTableProc(transactionsTable);
export const setUpTempTransactionResultsTable = new SetUpTempTableProc(transactionResultsTable);

export class QueryRes {
    duds: number = 0;
    newCount: number = 0;
    rolledBack: boolean = false;
}
class CommitTempRecordsProc implements SProc {
    constructor(
        public name: string,
        private srcTableName:string, 
        private table: TableDescription<Transaction | TransactionResult>, 
        private extra1: string = "", 
        private extra2: string = "") {
    }
    async batch(request: sql.Request): Promise<QueryRes> {
        const r = await request.batch(`EXEC ${this.name}`);
        const result = new QueryRes();   
        result.duds = r.recordset[0][duds];
        result.newCount = r.recordset[0][newCount];
        return result;
    }
    getProcedureQuery(): string {
        const tIdColumn = this.table.columns.id;
        return procedureQuery(this.name, "", [], `
        ${this.extra1}
        declare @${newCount} int;
        declare @${duds} int;
        set @${duds} = 0;
        BEGIN TRY
            INSERT INTO ${this.table.name}
            SELECT ${(Object.values(this.table.columns)).map(c  => c.name).join(',')} FROM ${this.srcTableName};
            set @${newCount} = @@ROWCOUNT;
        END TRY
        BEGIN CATCH
            CREATE NONCLUSTERED INDEX temp_idx ON ${this.srcTableName}(${tIdColumn.name}, iddx);
            with rowNumberd as (select *, 
                                ROW_NUMBER() over (partition by ${tIdColumn.name} order by iddx) as rowNum
                                from ${this.srcTableName}),
            marked as (select t2.${tIdColumn.name} as t2sid, t3.*
                        from rowNumberd as t3
                        left join ${this.table.name} as t2
                        on t2.${tIdColumn.name} = t3.${tIdColumn.name})
                select * into ${this.srcTableName}marked from marked;
        
            CREATE NONCLUSTERED INDEX temp_idx2 ON ${this.srcTableName}marked(t2sid, rowNum, iddx);
            CREATE NONCLUSTERED INDEX temp_idx3 ON ${this.srcTableName}marked(rowNum);

            with distinctNew as (select * from ${this.srcTableName}marked
                                where t2sid is null and rowNum = 1)
                select * into #distinctNew from distinctNew;
                
            insert into ${this.table.name} 
                select ${(Object.values(this.table.columns) as ColumnDescription[]).map(c  => c.name).join(',')}
                from #distinctNew;

            set @${newCount} = @@ROWCOUNT;

            with nonDistinct as (select * from ${this.srcTableName}marked
                                where t2sid is not null or rowNum > 1
                                ),
            jsonned as (SELECT data
                        FROM nonDistinct AS t
                        CROSS APPLY (
                            SELECT ${(Object.values(this.table.columns) as ColumnDescription[]).map(c  => `t.${c.name} as ${c.name}`).join(',')}
                            FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
                        ) AS derived(data))
                insert into ${rawDataTable.name} select * from jsonned;

            set @${duds} = @@ROWCOUNT;
            ${this.extra2}
            END CATCH;
            select @${duds} as ${duds}, @${newCount} as ${newCount};`);
    }
}
function addNewUserIfNotExists(): string {
    const tt = setUpTempTransactionsTable.tableName;
    const tc_uFrom = transactionsTable.columns.userIdFrom.name;
    const tc_uTo = transactionsTable.columns.userIdTo.name;
    return `with allUsers as (select distinct ${tc_uFrom} as id
                        from ${tt}
                        union
                        select distinct ${tc_uTo} as id
                        from ${tt}),
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
function addToTransactionsByUser(): string {
    const tIdColumn = transactionsTable.columns.id;
    const tc_uFrom = transactionsTable.columns.userIdFrom.name;
    const tc_uTo = transactionsTable.columns.userIdTo.name;
    const tc_date = transactionsTable.columns.dateTime.name;
    return `insert into ${transactionsByUserTable.name}
        select ${tc_uFrom}, ${tc_date}, ${tIdColumn.name} from #distinctNew
        union
        select ${tc_uTo}, ${tc_date}, ${tIdColumn.name} from #distinctNew
        where ${tc_uFrom} != ${tc_uTo};
    `;
}
export const commitRecordedTransacrionsProc = 
        new CommitTempRecordsProc(`${schema}.CommitRecordedTransactions`,
                                setUpTempTransactionsTable.tableName, 
                                transactionsTable,
                                addNewUserIfNotExists(), 
                                addToTransactionsByUser());
export const commitRecordedTransacrionResultsProc = 
        new CommitTempRecordsProc(`${schema}.CommitRecordedTransactionResults`,
                                setUpTempTransactionResultsTable.tableName, 
                                transactionResultsTable)


