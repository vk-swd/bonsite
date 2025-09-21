import { MAX_DATE, MIN_DATE, StatementParameters, TResult, UserDataRequestParameters } from "../event_types.js";
import { getTopUsersProcedureQuery, getUserProcedureQuery, procedureQuery } from "./queries.js";
import { Column, Columns, kafkaOffsetTable, makeCol, parseQueryRes, rawDataTable, schema, sqlTypes, statTable, TableDescription, transactionResultsDumpTable, transactionResultsTable, TransactionResultStored, transactionsDumpTable, transactionsTable, TransactionStored, usersTable } from "./tables.js";
import sql from 'mssql'



interface SProc<T> {
    procName: string;
    columns?: Column<T, keyof T>[];
    getProcedureQuery(): string;
}


function makeProc<T>(procName: string, columns: Columns<T>, query: (name: string) => string): SProc<T> {
    const procQuery = query(procName);
    return {
        procName,
        columns: Object.values(columns),
        getProcedureQuery: () => procQuery
    };
}

export const UsersRequestC: Columns<UserDataRequestParameters> = {
    cursor: makeCol("cursor", usersTable.columns.idx.type),
    count: makeCol("count", sqlTypes.int),
    pattern: makeCol("pattern", sqlTypes.nvarchar)    
};
export const getUsersProc = makeProc(`${schema}.getUsers`, UsersRequestC, getUserProcedureQuery);
export const getUsersTopProc = makeProc(`${schema}.getTopUsers`, UsersRequestC, getTopUsersProcedureQuery);
const tResT = transactionResultsTable;

export type CommitResults = { duds: number; newCount: number };
export const CommitResultsC: Columns<CommitResults> = {
    duds: makeCol("duds", sqlTypes.int),
    newCount: makeCol("newCount", sqlTypes.int)
};

type StatementReqParam = Omit<{ idx: number } & StatementParameters, "type"|"offset"|"count">;
export const StatmentParamTable: TableDescription<StatementReqParam> = {
    name: `#tempParamTable`,
    columns: {
        idx: makeCol("idx", sqlTypes.int, "identity(1,1) primary key"),
        userId: makeCol("userId", usersTable.columns.id.type),
        fromm: makeCol("fromm", transactionsTable.columns.dateTime.type, undefined, (c) => new Date(c.fromm ?? MIN_DATE).toISOString()),
        too: makeCol("too", transactionsTable.columns.dateTime.type, undefined, (c) => new Date(c.too ?? MAX_DATE).toISOString())
    },
    permissions: []
};
class GetTransactionsProc implements SProc<StatementReqParam> {
    public procName = `${schema}.getTransactions`;
    columns = Object.values(StatmentParamTable.columns);
    query: string  = ""
    constructor() {
        const selectUsers = (srcColumn: string) => {
            const from = StatmentParamTable.columns.fromm!.name;
            const to = StatmentParamTable.columns.too!.name;
            const id = StatmentParamTable.columns.userId.name;
            const idx = StatmentParamTable.columns.idx.name;
            return `select p.${id} as pid, p.${idx} as pidx, t.*
            from ${StatmentParamTable.name} as p
            left join
            ${transactionsTable.name} as t
            on t.${srcColumn} = p.${id}
            left join
            ${transactionResultsTable.name} as r
            on r.${transactionResultsTable.columns.id.name} = t.${transactionsTable.columns.id.name}
            where t.${transactionsTable.columns.dateTime.name} between p.${from} and p.${to}
            and r.${transactionResultsTable.columns.state.name} = ${TResult.CONFIRMED}`;
        }
        this.query =
        `
        CREATE PROCEDURE ${this.procName}
            AS
            SET NOCOUNT ON;
        with unioned as (
        ${selectUsers(transactionsTable.columns.userIdFrom.name)}
        union all
        ${selectUsers(transactionsTable.columns.userIdTo.name)}
        and t.${transactionsTable.columns.userIdTo.name} != t.${transactionsTable.columns.userIdFrom.name}
        )
        select * from unioned order by pidx, ${transactionsTable.columns.dateTime.name}
        `
        ;
    }

    getProcedureQuery(): string {
        return this.query;
    }
}
export const procGetTransactions = new GetTransactionsProc();

function fullColumnNamesEqItsProcArgs<T, K extends keyof T>(c: Column<T,K>[], sep: string = ', '): string {
    return c.map(col =>  `${col.inputName} = ${col.parameterName}`).join(sep);
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
    return columns.map(c => c.inputName).join(', ');
}
function insertQuery<T, K extends keyof T>(name: string, columns: Column<T,K>[]): string {
    return `INSERT INTO ${name} (${columnsToValues(columns)})
            VALUES (${columns.map(c => c.parameterName).join(',')});`
}
class AddKafkaOffsetProcedure implements SProc<{}> {
    public procName = `${schema}.addKafkaOffset`;
    getProcedureQuery(): string {
        return procedureQuery(this.procName, Object.values(kafkaOffsetTable.columns), `
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
    async batch(request: sql.Request): Promise<CommitResults> {
        const r = await request.batch(`EXEC ${this.procName};`);
        return parseQueryRes<CommitResults>(r.recordset[0], CommitResultsC);
    }
    getProcedureQuery(): string {
        return this.procQuery;
    }
    constructor(public procName: string, tmpTable: TableDescription<T>, dstTable: TableDescription<T>, public dumpTable: TableDescription<T>) {
        let extra1: string = "";

        const distinctNew = "distinctNew";
        const tmpDistinctNew = `#${distinctNew}`

        if (dstTable.name == transactionsTable.name) {
            const tc_uFrom = transactionsTable.columns.userIdFrom.name;
            const tc_uTo = transactionsTable.columns.userIdTo.name;
            const idLocal = `id`
            extra1 = `
            with allUsers as (select distinct ${tc_uFrom} as ${idLocal}
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
            ;
        }
        const tIdColumn = tmpTable.columns.id;
        const tIdxColumn = tmpTable.columns.idx;
        const tmpTabNumbered = `tmpTabNumbered`;
        const rowNumColumn = `rowNum`;
        const existingId = "EXISTS_ID";
        const markedTab = `marked`;
        const dataColumns = Object.values(dstTable.columns).slice(1).map(c => c.name).join(', ');


        const labels: string[] = ["@l1"];
        const measureTime = (label: string): string => {
            if (labels.length == 1) {
                labels.push("@l2");
                return `declare ${labels[0]} datetime2(3);
                    declare ${labels[1]} datetime2(3);
                    SET ${labels[0]} = SYSDATETIME();`
            } else {
                const res = `SET ${labels[1]} = SYSDATETIME();
                insert into ${statTable.name} (${statTable.columns.name.name},
                                            ${statTable.columns.value.name})
                            values ('${label}',
                            DATEDIFF(millisecond, ${labels[0]}, ${labels[1]}));`
                const tmp = labels[0];
                labels.shift();
                labels.push(tmp);
                return res;
            }
        }
        this.procQuery = procedureQuery(this.procName, [], `

        ${Object.values(CommitResultsC).map(c => `declare ${c.parameterName} ${c.type.name};`).join('\n')}
        ${Object.values(CommitResultsC).map(c => `set ${c.parameterName} = 0;`).join('\n')}

        ${measureTime("")}
        ${extra1}

        declare @handled int;
        set @handled = 0;

        ${measureTime("checked users")}
        BEGIN TRY
            INSERT INTO ${dstTable.name}
            SELECT ${dataColumns} FROM ${tmpTable.name};
            set ${CommitResultsC.newCount.parameterName} = @@ROWCOUNT;
            set @handled = 1;
        END TRY
        BEGIN CATCH
            ${measureTime("shat pants")}
            CREATE NONCLUSTERED INDEX someindex ON ${tmpTable.name} (${tIdColumn.name})
            ${measureTime("made culstered index")}

            with  ${tmpTabNumbered} as (select *,
                                ROW_NUMBER() over (partition by ${tIdColumn.name} order by ${tIdxColumn.name}) as ${rowNumColumn}
                                from ${tmpTable.name}),
            ${markedTab} as (select tDst.${tIdColumn.name} as ${existingId}, tNumbered.*
                        from  ${tmpTabNumbered} as tNumbered
                        left join ${dstTable.name} as tDst
                        on tDst.${tIdColumn.name} = tNumbered.${tIdColumn.name}),
            ${distinctNew} as (select * from ${markedTab}
                               where ${existingId} is not null or ${rowNumColumn} > 1)
            insert into ${dumpTable.name}
                             select ${dataColumns}
                              from ${distinctNew}

            set ${CommitResultsC.duds.parameterName} = @@ROWCOUNT;


            ${measureTime("saved raw data of duds")}


            with  ${tmpTabNumbered} as (select *,
                                ROW_NUMBER() over (partition by ${tIdColumn.name} order by ${tIdxColumn.name}) as ${rowNumColumn}
                                from ${tmpTable.name}),
            ${markedTab} as (select tDst.${tIdColumn.name} as ${existingId}, tNumbered.*
                        from  ${tmpTabNumbered} as tNumbered
                        left join ${dstTable.name} as tDst
                        on tDst.${tIdColumn.name} = tNumbered.${tIdColumn.name}),
            ${distinctNew} as (select * from ${markedTab}
                               where ${existingId} is null and ${rowNumColumn} = 1)
             insert into ${dstTable.name}
                             select ${dataColumns}
                              from ${distinctNew}
            set ${CommitResultsC.newCount.parameterName} = @@ROWCOUNT;

            ${measureTime("selected unique ores and inserted in dst")}

            --save conflicted and duplicate records to raw data table for further analysis

            set @handled = 1;
            END CATCH;

            ${measureTime("end")}
            select ${Object.values(CommitResultsC).map(c => `${c.parameterName} as ${c.name}`).join(', ')};
            `
        );
    }
}

export class SetUpTempTableProc<T extends TransactionResultStored | TransactionStored> implements SProc<T> {
    public procName: string
    public tableName: string
    public dstTable: TableDescription<T>
    private insertionProc: SProc<T>
    private pr: CommitTempRecordsProc<T>

    constructor(public srcTable: TableDescription<T>, private dumpTable: TableDescription<T>) {
        const tName = srcTable.name.replace(/\./g, '');
        this.tableName = `#${tName}`;
        // this.tableName = `${srcTable.name}temp`;
        this.procName = `${schema}.create${tName}`;
        this.dstTable = {...srcTable, name: this.tableName};

        const insertionProcName = `${schema}.insertTo${tName}`;
        const unsertProcQuery = procedureQuery(insertionProcName,
            Object.values(this.dstTable.columns).slice(1),
        insertQuery(this.dstTable.name, Object.values(this.dstTable.columns).slice(1)))
        this.insertionProc = {
            procName: insertionProcName,
            columns: Object.values(this.dstTable.columns).slice(1),
            getProcedureQuery: () => unsertProcQuery
        }
        this.pr = new CommitTempRecordsProc<T>(`${schema}.CommitRecorded${tName}`, this.dstTable, this.srcTable, dumpTable);
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
export const setUpTempTransactionsTable = new SetUpTempTableProc(transactionsTable, transactionsDumpTable);
export const setUpTempTransactionResultsTable = new SetUpTempTableProc(transactionResultsTable, transactionResultsDumpTable);

export class QueryRes {
    duds: number = 0;
    newCount: number = 0;
    rolledBack: boolean = false;
}



