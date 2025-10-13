import { TResult } from "../event_types.js";
import { logger } from "../logger.js";
import { CommitResultsC, DBStateC, RotateTableArgs, RotateTableResultC, StatmentParamTable, UserDateRangeC, UsersRequestC } from "./procedures.js";
import { Column, rawDataTable, statTable, statTableReads, Stringed, TableDescription, transactionResultsDumpTable, transactionResultsTable, TransactionResultStored, transactionsDumpTable, transactionsTable, TransactionStored, usersTable } from "./tables.js";



export function procedureQuery<T, K extends keyof T>(procedureName: string, columns: Column<T,K>[], tail: string): string {
    return `CREATE PROCEDURE ${procedureName}
        ${columns.map(c => `${c.parameterName} ${c.type.name}`).join(',\n')}
        AS
        begin
        SET NOCOUNT ON;
        ${tail}
        end;`;
}

function matchedUserCountQuery() {
    return `select count(*) as totalCount from ${usersTable.name}
        where ${usersTable.columns.name.name} like ${UsersRequestC.pattern.parameterName}`;
}
export function getTopUsersProcedureQuery(name: string) {
    return procedureQuery(name, [UsersRequestC.count, UsersRequestC.pattern],
        `select top (${UsersRequestC.count.parameterName})
        * from ${usersTable.name}
        where ${usersTable.columns.name.name} like ${UsersRequestC.pattern.parameterName}
        order by ${usersTable.columns.idx.name};
        ${matchedUserCountQuery()};`);
}
export function getUserProcedureQuery(name: string) {
    /*  The query is designed to handle situation when some items were deleted
        while the sections (pages) of matched records were traversed.
        It does not handle all the edge cases, most of them can be fixed by sending
        another request. Also the reliability of users traversal
        is not critical for the use case addressed by that query.

        For reliabiliyty pagination should be done over a stable data snapshot,
        where this query will still work, but simple offset traversal would be better.
    */
    const windowSize = UsersRequestC.count.parameterName;
    const anchorIdx = UsersRequestC.cursor!.parameterName;
    const filterPattern = UsersRequestC.pattern.parameterName;
    const afterItemsTab = `afterItems`;
    const beforeItemsTab = `beforeItems`;
    const unionedTab = `unioned`;
    return procedureQuery(name, Object.values(UsersRequestC), `
    with ${afterItemsTab}
        as (select top (CAST(${windowSize} / 2 as INT)) * from ${usersTable.name}
            where ${usersTable.columns.idx.name} > ${anchorIdx}
            and ${usersTable.columns.name.name} like ${filterPattern}
            order by ${usersTable.columns.idx.name}),
        ${beforeItemsTab}
        as (select top (${windowSize}) * from ${usersTable.name}
            where ${usersTable.columns.idx.name} <= ${anchorIdx}
            and ${usersTable.columns.name.name} like ${filterPattern}
            order by ${usersTable.columns.idx.name} desc),
        ${unionedTab}
        as (select * from ${afterItemsTab} union all select * from ${beforeItemsTab})
        select a.* from
        (select top (${windowSize}) * from ${unionedTab} order by ${usersTable.columns.idx.name} desc) a
        order by ${usersTable.columns.idx.name}
        ${matchedUserCountQuery()};
    `);
}

export function getDBState(name: string) {
    const getRowCOunt = (tableName: string) => `
        (select count(*) from  ${tableName} u)`
    const getMaxId = (table: TableDescription<any>) => `
        isnull((select max(${table.columns.id.name}) from  ${table.name}), 0)`;
    const getLastRecord = (tableName: string) => `
        isnull((select top 1 * from ${tableName} t order by idx desc for json path, without_array_wrapper), '{}')`;
    return procedureQuery(name, [], `
        ${Object.values(DBStateC).map(c => `declare ${c.parameterName} ${c.type.name};`).join('\n')}
        select 
        ${DBStateC.cpuBisy.parameterName}=@@CPU_BUSY,
        ${DBStateC.totalRead.parameterName}=@@TOTAL_READ,
        ${DBStateC.totalWrite.parameterName}=@@TOTAL_WRITE,
        ${DBStateC.totalErrors.parameterName}=@@TOTAL_ERRORS,
        ${DBStateC.userCount.parameterName}=${getRowCOunt(usersTable.name)},
        ${DBStateC.transactionCount.parameterName}=${getRowCOunt(transactionsTable.name)},
        ${DBStateC.maxUserId.parameterName}=${getMaxId(usersTable)},
        ${DBStateC.maxTransactionId.parameterName}=${getMaxId(transactionsTable)},
        ${DBStateC.maxTransactionResId.parameterName}=${getMaxId(transactionResultsTable)};

        set ${DBStateC.lastTransactionPosted!.parameterName}=(${getLastRecord(transactionsTable.name)});
        set ${DBStateC.lastTransactionRes!.parameterName}=(${getLastRecord(transactionResultsTable.name)});
        select ${Object.values(DBStateC).map(c => `${c.parameterName} as ${c.name}`).join(', ')};
    `);
}
export function getUserDateRange(name: string) {
    return procedureQuery(name, [UserDateRangeC.userId], `
        SELECT MIN(${transactionsTable.columns.dateTime.name}) as ${UserDateRangeC.minDate!.name},
        MAX(${transactionsTable.columns.dateTime.name}) as ${UserDateRangeC.maxDate!.name}
        FROM ${transactionsTable.name}
        WHERE ${transactionsTable.columns.userIdFrom.name} = ${UserDateRangeC.userId.parameterName} OR
              ${transactionsTable.columns.userIdTo.name} = ${UserDateRangeC.userId.parameterName};`)
}

export function recordUsersInTransactionsQuery(tmpTableName: string) {
    const idLocal = `id`
    return `
    with allUsers as (select distinct ${transactionsTable.columns.userIdFrom.name} as ${idLocal}
                        from ${tmpTableName}
                        union
                        select distinct ${transactionsTable.columns.userIdTo.name} as ${idLocal}
                        from ${tmpTableName}),
        usersFrom as (select distinct ${idLocal} from allUsers),
        namedUFrom as (select ${idLocal},
                            'User' + CAST(${idLocal} AS NVARCHAR) as Name
                        from usersFrom)
            insert into ${usersTable.name}
            select ${idLocal} as ${usersTable.columns.id.name}, 
                    Name as ${usersTable.columns.name.name}
            from namedUFrom
            where not exists (select 1 from ${usersTable.name}
                                where ${usersTable.columns.id.name} = namedUFrom.id);
    `
    ;
}
export function commitTransactionQuery(name:string, tmpTableName: string, dumpTableName: string, 
                                        dstTable: TableDescription<TransactionResultStored | TransactionStored>,
                                    extra1: string = ""): string {
    
    const l1: Stringed<typeof statTable.columns> = Object.fromEntries(
        Array.from(Object.entries(statTable.columns)).map(c => [c[0], c[1].parameterName! + "_s1"])
    ) as Stringed<typeof statTable.columns>;
    const l2: Stringed<typeof statTable.columns> = Object.fromEntries(
        Array.from(Object.entries(statTable.columns)).map(c => [c[0], c[1].parameterName! + "_s2"])
    ) as Stringed<typeof statTable.columns>;
    const labels = [l1];
    const measureTime = (label: string): string => {
        if (labels.length == 1) {
            labels.push(l2);
            return `
                declare ${labels[0].value} datetime2(3);
                declare ${labels[0].reads} bigint;
                declare ${labels[0].writes} bigint;
                declare ${labels[0].busy} bigint;
                declare ${labels[0].logUnused} bigint;
                declare ${labels[0].dataUnused} bigint;
                declare ${labels[1].value} datetime2(3);
                declare ${labels[1].reads} bigint;
                declare ${labels[1].writes} bigint;
                declare ${labels[1].busy} bigint;
                declare ${labels[1].logUnused} bigint;
                declare ${labels[1].dataUnused} bigint;
                SET ${labels[0].value} = SYSDATETIME();
                SET ${labels[0].reads} = @@TOTAL_READ;
                SET ${labels[0].writes} = @@TOTAL_WRITE;
                SET ${labels[0].busy} = @@CPU_BUSY;
    SELECT 
		${labels[0].logUnused} = sum(CAST(size/128.0 - CAST(FILEPROPERTY(name, 'SpaceUsed') AS int)/128.0 AS decimal(19,4)))
	FROM sys.database_files
	WHERE type_desc = 'LOG';
	
	SELECT 
		${labels[0].dataUnused} = sum(CAST(size/128.0 - CAST(FILEPROPERTY(name, 'SpaceUsed') AS int)/128.0 AS decimal(19,4)))
	FROM sys.database_files
	WHERE type_desc <> 'LOG';
            `
        } else {
            const res = `
                SET ${labels[1].value} = SYSDATETIME();
                SET ${labels[1].reads} = @@TOTAL_READ;
                SET ${labels[1].writes} = @@TOTAL_WRITE;
                SET ${labels[1].busy} = @@CPU_BUSY;
    SELECT 
		${labels[1].logUnused} = sum(CAST(size/128.0 - CAST(FILEPROPERTY(name, 'SpaceUsed') AS int)/128.0 AS decimal(19,4)))
	FROM sys.database_files
	WHERE type_desc = 'LOG';
	
	SELECT 
		${labels[1].dataUnused} = sum(CAST(size/128.0 - CAST(FILEPROPERTY(name, 'SpaceUsed') AS int)/128.0 AS decimal(19,4)))
	FROM sys.database_files
	WHERE type_desc <> 'LOG';
                insert into ${statTable.name} 
                (${Object.values(statTable.columns).slice(1).map(c => c.name).join(',')})
                values ('${label}',DATEDIFF(millisecond, ${labels[0].value}, ${labels[1].value}),
                ${labels[1].reads}-${labels[0].reads}, 
                ${labels[1].writes}-${labels[0].writes}, 
                (${labels[1].busy}-${labels[0].busy}) * CAST(@@TIMETICKS AS FLOAT),
                ${labels[1].logUnused},
                ${labels[1].dataUnused}
                );`
            const tmp = labels[0];
            labels.shift();
            labels.push(tmp);
            return res;
        }
    }

    const tIdColumn = dstTable.columns.id;
    const tIdxColumn = dstTable.columns.idx;
    const distinctNew = "distinctNew";
    const tmpTabNumbered = `tmpTabNumbered`;
    const rowNumColumn = `rowNum`;
    const existingId = "EXISTS_ID";
    const markedTab = `marked`;
    const dataColumns = Object.values(dstTable.columns).slice(1).map(c => c.name).join(', ');

    return procedureQuery(name, [], `

    ${Object.values(CommitResultsC).map(c => `declare ${c.parameterName} ${c.type.name};`).join('\n')}
    ${Object.values(CommitResultsC).map(c => `set ${c.parameterName} = 0;`).join('\n')}

    ${measureTime("")}
    ${extra1}

    declare @handled int;
    set @handled = 0;

    ${measureTime("checked users")}
    BEGIN TRY
        INSERT INTO ${dstTable.name}
        SELECT ${dataColumns} FROM ${tmpTableName};
        set ${CommitResultsC.newCount.parameterName} = @@ROWCOUNT;
        set @handled = 1;
    END TRY
    BEGIN CATCH
        ${measureTime("shat pants")}
        CREATE NONCLUSTERED INDEX someindex ON ${tmpTableName} (${tIdColumn.name})
        ${measureTime("made culstered index")}

        with  ${tmpTabNumbered} as (select *,
                            ROW_NUMBER() over (partition by ${tIdColumn.name} order by ${tIdxColumn.name}) as ${rowNumColumn}
                            from ${tmpTableName}),
        ${markedTab} as (select tDst.${tIdColumn.name} as ${existingId}, tNumbered.*
                    from  ${tmpTabNumbered} as tNumbered
                    left join ${dstTable.name} as tDst
                    on tDst.${tIdColumn.name} = tNumbered.${tIdColumn.name}),
        ${distinctNew} as (select * from ${markedTab}
                           where ${existingId} is not null or ${rowNumColumn} > 1)
            insert into ${dumpTableName}
                             select ${dataColumns}
                              from ${distinctNew}
        set ${CommitResultsC.duds.parameterName} = @@ROWCOUNT;

        ${measureTime("saved raw data of duds")}

        with ${tmpTabNumbered} as (select *,
                            ROW_NUMBER() over (partition by ${tIdColumn.name} order by ${tIdxColumn.name}) as ${rowNumColumn}
                            from ${tmpTableName}),
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
        CHECKPOINT;
        ${measureTime("CHECKPOINTED")}

        select ${[...Object.values(CommitResultsC)]
        .map(c => `${c.parameterName} as ${c.name}`).join(', ')};
        select SCHEMA_ID('${dstTable.name.split('.')[0]}') as schema_id;
        `
    );
}

export function maybeRrotateRowsQuery(name: string) {
    const DB_DATA_SIZE_LIMIT = 1024 * 1024 * 1024 * 2; // TODO: make it configurable
    const usedSpaceQuery = `(SELECT
                    SUM(CAST(FILEPROPERTY(name, 'SpaceUsed') AS decimal(11,1)) * 8 * 1024) AS space_used_mb
                FROM sys.database_files
                WHERE type = 0)`; // data files
    const removedArg = RotateTableResultC.removed.parameterName;
    const usedSpaceBytesArg = RotateTableResultC.usedSpaceBytes.parameterName;
    const usedSpaceBytesNewArg = RotateTableResultC.usedSpaceBytesNew.parameterName;
    return procedureQuery(name, [RotateTableArgs.columns], `
        declare ${usedSpaceBytesArg} bigint;
        select ${usedSpaceBytesArg} = ${usedSpaceQuery};
        declare ${removedArg} bigint;
        set ${removedArg} = 0;
        declare ${usedSpaceBytesNewArg} bigint;
        set ${usedSpaceBytesNewArg} = ${usedSpaceBytesArg};
        if (${usedSpaceBytesArg} > ${DB_DATA_SIZE_LIMIT}) 
        begin
            ${[transactionsTable,
                transactionResultsTable,
                rawDataTable,
                transactionsDumpTable,
                transactionResultsDumpTable].map(t => `
                    with opa as (select top (${RotateTableArgs.columns.parameterName}) * from ${t.name} order by ${t.columns.idx.name}) 
                        delete from opa;
                    set ${removedArg} = @@ROWCOUNT + ${removedArg};
                    `).join('\n')}
            select ${usedSpaceBytesNewArg} = ${usedSpaceQuery};
            CHECKPOINT;
        end;
        select ${Object.values(RotateTableResultC).map(c => `${c.parameterName} as ${c.name}`).join(', ')} 
        , ${RotateTableArgs.columns.parameterName} as ${RotateTableArgs.columns.name};
    `)
} 

export function getUserStatementsProcQuery(name: string) {
    const l1: Stringed<typeof statTableReads.columns> = Object.fromEntries(
        Array.from(Object.entries(statTableReads.columns)).map(c => [c[0], c[1].parameterName! + "_s1"])
    ) as Stringed<typeof statTableReads.columns>;
    const l2: Stringed<typeof statTableReads.columns> = Object.fromEntries(
        Array.from(Object.entries(statTableReads.columns)).map(c => [c[0], c[1].parameterName! + "_s2"])
    ) as Stringed<typeof statTableReads.columns>;
    const labels = [l1];
    const measureTime = (label: string): string => {
        if (labels.length == 1) {
            labels.push(l2);
            return `
                declare ${labels[0].value} datetime2(3);
                declare ${labels[1].value} datetime2(3);
                SET ${labels[0].value} = SYSDATETIME();
            `
        } else {
            const res = `
                SET ${labels[1].value} = SYSDATETIME();
                insert into ${statTableReads.name} 
                (${Object.values(statTableReads.columns).slice(1).map(c => c.name).join(',')})
                values (CONCAT('${label}_', @@ROWCOUNT),DATEDIFF(millisecond, ${labels[0].value}, ${labels[1].value}));`
            const tmp = labels[0];
            labels.shift();
            labels.push(tmp);
            return res;
        }
    }
    const selectUsers = (srcColumn: string) => {
        return `select 
            p.${StatmentParamTable.columns.userId.name} as pid, 
            p.${StatmentParamTable.columns.idx.name} as pidx, 
            t.*
        from ${StatmentParamTable.name} as p
        left join
        ${transactionsTable.name} as t
        on t.${srcColumn} = p.${StatmentParamTable.columns.userId.name}
        left join
        ${transactionResultsTable.name} as r
        on r.${transactionResultsTable.columns.id.name} = t.${transactionsTable.columns.id.name}
        where t.${transactionsTable.columns.dateTime.name} 
                between p.${StatmentParamTable.columns.fromm!.name} and 
                        p.${StatmentParamTable.columns.too!.name}
        and r.${transactionResultsTable.columns.state.name} = ${TResult.CONFIRMED}`;
    }

    return `
    CREATE PROCEDURE ${name}
        AS
        SET NOCOUNT ON;
    begin
        ${measureTime('')}
        with unioned as (
        ${selectUsers(transactionsTable.columns.userIdFrom.name)}
        union all
        ${selectUsers(transactionsTable.columns.userIdTo.name)}
        and t.${transactionsTable.columns.userIdTo.name} != t.${transactionsTable.columns.userIdFrom.name}
        )
        select * from unioned order by pidx, ${transactionsTable.columns.dateTime.name};
        ${measureTime('getTransactions')};
    end;`;
}