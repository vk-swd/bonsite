import { StatementParameters, TResult } from "../event_types.js";
import { Column, Columns, kafkaOffsetTable, makeCol, rawDataTable, schema, TableDescription, transactionResultsTable, TransactionResultStored, transactionsByUserTable, transactionsTable, TransactionStored, usersTable } from "./tables.js";
import * as sql from 'mssql'



interface SProc<T> {
    name: string;
    columns?: Column<T, keyof T>[];
    getProcedureQuery(): string;
}

const resultStruct = ["duds", "newCount"];
const [duds, newCount] = resultStruct;


const tResT = transactionResultsTable;
const tPerUserT = transactionsByUserTable;


const StatmentParamPseudoColumns: Columns<StatementParameters> = {
    userId: makeCol("userId", transactionsByUserTable.columns.userId.type),
    from: makeCol("from", transactionsByUserTable.columns.date.type, undefined, (c) => new Date(c.from ?? "1970-01-01T00:00:00.000Z").toISOString()),
    to: makeCol("to", transactionsByUserTable.columns.date.type, undefined, (c) => new Date(c.to ?? "9999-12-31T23:59:59.997Z").toISOString())
};
class GetTransactionsProc implements SProc<StatementParameters> {
    public name = `${schema}.getTransactions`;
    columns: Column<StatementParameters, keyof StatementParameters>[];
    query: string
    constructor() {
        const cInfo = StatmentParamPseudoColumns;
        this.columns = Object.values(cInfo);
        this.query = `
            CREATE PROCEDURE ${this.name}
            ${this.columns.map(t => `${t.parameterName} ${t.type.name}`).join(',\n')}
            AS
            SET NOCOUNT ON;
            with selectedIds as (SELECT tByUser.${tPerUserT.columns.transId.name}
                                    FROM ${tPerUserT.name} as tByUser
                                left join ${tResT.name} as tr
                                    on tByUser.${tPerUserT.columns.transId.name} = tr.${tResT.columns.id.name}
                                WHERE ${tPerUserT.columns.userId.name} = ${cInfo.userId.parameterName} 
                                    AND ${tPerUserT.columns.date.name} BETWEEN ${cInfo.from!.parameterName} AND ${cInfo.to!.parameterName}
                                    and tr.${tResT.columns.state.name} = ${TResult.CONFIRMED})
                SELECT * FROM ${transactionsTable.name} 
                WHERE ${transactionsTable.columns.id.name} IN (
                SELECT ${tPerUserT.columns.transId.name} FROM selectedIds);
        `
    }
    getProcedureQuery(): string {
        return this.query;
    }
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

export function procedureQuery<T, K extends keyof T>(procedureName: string, columns: Column<T,K>[], tail: string): string {
    return `CREATE PROCEDURE ${procedureName}
        ${columns.map(c => `${c.parameterName} ${c.type.name}`).join(',\n')}
        AS
        SET NOCOUNT ON;
        ${tail}`;
}

function fullColumnNamesEqItsProcArgs<T, K extends keyof T>(c: Column<T,K>[], sep: string = ', '): string {
    return c.map(col =>  `${col.name} = ${col.parameterName}`).join(sep);
}
function ifExistsQuery<T, K extends keyof T>(tableName: string, lookedUpColumns: Column<T,K>[]): string {
    return `EXISTS (SELECT 1
            FROM ${tableName}
            WHERE ${fullColumnNamesEqItsProcArgs(lookedUpColumns, ' AND ')})`;
}
function updateQuery<T, K extends keyof T>(tableName: string, updatedColumn: Column<T,K>[], lookedUpColumns: Column<T,K>[]): string {
    return `UPDATE ${tableName}
            SET  ${fullColumnNamesEqItsProcArgs(updatedColumn)}
            WHERE (${fullColumnNamesEqItsProcArgs(lookedUpColumns, ' AND ')})`
}
function columnsToValues<T, K extends keyof T>(columns: Column<T,K>[]): string {
    return columns.map(c => `${c.name}`).join(', ');
}
function insertQuery<T, K extends keyof T>(name: string, columns: Column<T,K>[]): string {
    return `INSERT INTO ${name} (${columnsToValues(columns)})
            VALUES (${columns.map(c => `@${c.name}`).join(',')});`
}
class AddKafkaOffsetProcedure {
    public name = `${schema}.addKafkaOffset`;
    getProcedureQuery(): string {
        return procedureQuery(this.name, Object.values(kafkaOffsetTable.columns), `
                if ${ifExistsQuery(kafkaOffsetTable.name, Object.values(kafkaOffsetTable.columns).slice(0,-1))}
                    ${updateQuery(kafkaOffsetTable.name, [kafkaOffsetTable.columns.offset], Object.values(kafkaOffsetTable.columns).slice(0,-1))}
                else 
                    ${insertQuery(kafkaOffsetTable.name, Object.values(kafkaOffsetTable.columns))}
            `)
    }
}
export const addKafkaOffsetProcedure = new AddKafkaOffsetProcedure();

class CommitTempRecordsProc<T extends TransactionStored | TransactionResultStored> implements SProc<T> {
    procQuery: string;
    async batch(request: sql.Request): Promise<QueryRes> {
        const r = await request.batch(`EXEC ${this.name}`);
        const result = new QueryRes();   
        result.duds = r.recordset[0][duds];
        result.newCount = r.recordset[0][newCount];
        return result;
    }
    getProcedureQuery(): string {
        return this.procQuery;
    }
    constructor(public name: string, tmpTable: TableDescription<T>, dstTable: TableDescription<T>) {
        let extra1: string = "", extra2: string = "", extra3: string = "";

        const distinctNew = "distinctNew";
        const tmpDistinctNew = `#${distinctNew}`

        if (dstTable.name == transactionsTable.name) {
            const tc_uFrom = transactionsTable.columns.userIdFrom.name;
            const tc_uTo = transactionsTable.columns.userIdTo.name;
            const idLocal = `id`
            extra1 = `with allUsers as (select distinct ${tc_uFrom} as ${idLocal}
                                from ${tmpTable.name}
                                union
                                select distinct ${tc_uTo} as ${idLocal}
                                from ${tmpTable.name}),
                usersFrom as (select distinct ${idLocal} from allUsers),
                namedUFrom as (select ${idLocal},
                                    'User' + CAST(${idLocal} AS NVARCHAR) as Name
                                from usersFrom)

                insert into ${usersTable.name}
                select ${idLocal} as ${usersTable.columns.id.name}, Name as ${usersTable.columns.name.name}
                from namedUFrom
                where not exists (select 1 from ${usersTable.name}
                                    where ${usersTable.columns.id.name} = namedUFrom.id);
            ` 
            const addToTransactionsByUser = (srcTableName: string): string => {
                const tIdColumn = transactionsTable.columns.id;
                const tc_date = transactionsTable.columns.dateTime.name;
                return `insert into ${transactionsByUserTable.name}
                    select ${tc_uFrom}, ${tc_date}, ${tIdColumn.name} from ${srcTableName}
                    union
                    select ${tc_uTo}, ${tc_date}, ${tIdColumn.name} from ${srcTableName}
                    where ${tc_uFrom} != ${tc_uTo}`;
            }
            extra2 += addToTransactionsByUser(tmpDistinctNew);
            extra3 += `
            IF @handled =0
            BEGIN
                ${addToTransactionsByUser(tmpTable.name)}
            END;
            `;
        }
        const tIdColumn = tmpTable.columns.id;
        const tIdxColumn = tmpTable.columns.idx;
        const tmpTabNumbered = `tmpTabNumbered`;
        const rowNumColumn = `rowNum`;
        const existingId = "EXISTS_ID";
        const markedTab = `marked`;
        const tmpMarkedTab = `#${markedTab}`;
        const dataColumns = Object.values(dstTable.columns).slice(1).map(c => c.name).join(', ');
       
        this.procQuery = procedureQuery(this.name, [], `
        ${extra1}
        declare @${newCount} int;
        declare @${duds} int;
        set @${duds} = 0;
        declare @handled int;
        set @handled = 0;
        BEGIN TRY
            INSERT INTO ${dstTable.name}
            SELECT ${dataColumns} FROM ${tmpTable.name};
            set @${newCount} = @@ROWCOUNT;
        END TRY
        BEGIN CATCH
            CREATE NONCLUSTERED INDEX temp_idx ON ${tmpTable.name}(${tIdColumn.name}, ${tIdxColumn.name});
            with  ${tmpTabNumbered} as (select *, 
                                ROW_NUMBER() over (partition by ${tIdColumn.name} order by ${tIdxColumn.name}) as ${rowNumColumn}
                                from ${tmpTable.name}),
            ${markedTab} as (select t2.${tIdColumn.name} as ${existingId}, t3.*
                        from  ${tmpTabNumbered} as t3
                        left join ${dstTable.name} as t2
                        on t2.${tIdColumn.name} = t3.${tIdColumn.name})
                select * into ${tmpMarkedTab} from ${markedTab};
        
            CREATE NONCLUSTERED INDEX temp_idx2 ON ${tmpMarkedTab}(${existingId}, ${rowNumColumn}, ${tIdxColumn.name});
            CREATE NONCLUSTERED INDEX temp_idx3 ON ${tmpMarkedTab}(${rowNumColumn});

            with ${distinctNew} as (select * from ${tmpMarkedTab}
                                where ${existingId} is null and ${rowNumColumn} = 1)
                select * into ${tmpDistinctNew} from ${distinctNew};
                
            insert into ${dstTable.name} 
                select ${dataColumns}
                from ${tmpDistinctNew};

            set @${newCount} = @@ROWCOUNT;

            --save conflicted and duplicate records to raw data table for further analysis
            with nonDistinct as (select * from ${tmpMarkedTab}
                                where ${existingId} is not null or ${rowNumColumn} > 1
                                ),
            jsonned as (SELECT data
                        FROM nonDistinct AS t
                        CROSS APPLY (
                            SELECT ${(Object.values(dstTable.columns)).map(c  => `t.${c.name} as ${c.name}`).join(',')}
                            FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
                        ) AS derived(data))
                insert into ${rawDataTable.name} select * from jsonned;

            set @${duds} = @@ROWCOUNT;
            ${extra2}

            set @handled = 1;
            END CATCH;
            ${extra3}
            select @${duds} as ${duds}, @${newCount} as ${newCount};`);
    }
}

class SetUpTempTableProc<T extends TransactionResultStored | TransactionStored> implements SProc<T> {
    public name: string
    public tableName: string
    public dstTable: TableDescription<T>
    private insertionProc: SProc<T>
    private pr: CommitTempRecordsProc<T>
    
 
    constructor(private srcTable: TableDescription<T>) {
        const tName = srcTable.name.replace(/\./g, '');
        this.tableName = `#${tName}`;
        this.name = `${schema}.create${tName}`;
        this.dstTable = {...srcTable, name: this.tableName};

        const insertionProcName = `${schema}.insertTo${tName}`;
        const unsertProcQuery = procedureQuery(insertionProcName, 
            Object.values(this.dstTable.columns).slice(1), 
        insertQuery(this.dstTable.name, Object.values(this.dstTable.columns).slice(1)))
        this.insertionProc = {
            name: insertionProcName,
            columns: Object.values(this.dstTable.columns).slice(1),
            getProcedureQuery: () => unsertProcQuery
        }
        this.pr = new CommitTempRecordsProc(`${schema}.CommitRecorded${tName}`, this.dstTable as TableDescription<any>, this.srcTable as TableDescription<any>);
    }
    getProcedureQuery(): string {
        return ""
    }
    async batch(request: sql.Request): Promise<void> {
        // Rely on the fact that original table has first column as identity primary key
        await request.batch(`create table ${this.dstTable.name} ( 
                    ${(Object.values(this.dstTable.columns))
                        .map((c, idx) => `${c.name} ${c.type.name} ${idx == 0 ? c.extra : ""}`).join(', ')})`)
    }
    async dropTable(request: sql.Request): Promise<void> {
        await request.batch(`DROP TABLE IF EXISTS ${this.dstTable.name}`);
    }
    getInsertionProcedure(): SProc<T> {
        return this.insertionProc;
    }
    getCommitProcedure(): CommitTempRecordsProc<T> {
        return this.pr;
        // return new CommitTempRecordsProc(`${schema}.CommitRecorded${this.srcTable.name.replace(/\./g, '')}`, this.dstTable, this.srcTable);
    }
}
export const setUpTempTransactionsTable = new SetUpTempTableProc(transactionsTable);
export const setUpTempTransactionResultsTable = new SetUpTempTableProc(transactionResultsTable);

export class QueryRes {
    duds: number = 0;
    newCount: number = 0;
    rolledBack: boolean = false;
}



