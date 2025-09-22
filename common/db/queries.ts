import { DBStateC, UsersRequestC } from "./procedures.js";
import { Column, transactionResultsTable, transactionsTable, usersTable } from "./tables.js";



export function procedureQuery<T, K extends keyof T>(procedureName: string, columns: Column<T,K>[], tail: string): string {
    return `CREATE PROCEDURE ${procedureName}
        ${columns.map(c => `${c.parameterName} ${c.type.name}`).join(',\n')}
        AS
        SET NOCOUNT ON;
        ${tail}`;
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
    const getRowCOunt = (tableName: string, colName: string) => `
        declare @${colName} Int
        select @${colName} = (select count(*) from  ${tableName} u)`;
    return procedureQuery(name, [], `
        ${getRowCOunt(usersTable.name, DBStateC.userCount.name)}
        ${getRowCOunt(transactionsTable.name, DBStateC.transactionCount.name)}
        select
        @${DBStateC.userCount.name} as ${DBStateC.userCount.name},
        @${DBStateC.transactionCount.name} as ${DBStateC.transactionCount.name},
        @@CPU_BUSY as ${DBStateC.cpuBisy.name},
        @@TOTAL_READ as ${DBStateC.totalRead.name},
        @@TOTAL_WRITE as ${DBStateC.totalWrite.name},
        @@TOTAL_ERRORS as ${DBStateC.totalErrors.name};
        select top 1 * from ${transactionsTable.name} t order by idx desc
        select top 1 * from ${transactionResultsTable.name} t order by idx desc
    `);

}