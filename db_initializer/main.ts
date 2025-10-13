import { getEnv } from "./common/utils.js";
import { connectToDatabase } from "./common/db/common.js";
import { createSchema } from "./common/db/init.js";
import { logger } from "./common/logger.js";
import { runQuery } from "./common/db/common.js";
import { sinkRole, statementCreatorRole } from "./common/db/auth.js";
import * as sql from 'mssql'


logger.log(`1`)
const now = Date.now();
const user_sa = getEnv('MSSQL_SA_USERNAME')
logger.log(`Starting DB initialization at ${new Date(now).toISOString()}`)
let pool: sql.ConnectionPool | undefined = undefined;
let retries = 10;
while (!pool && retries > 0) {
    try {
        pool = await connectToDatabase(user_sa);
        retries = 0;
    } catch (e) {
        logger.log(`Waiting for DB to be ready... ${retries} retries left`);
        await new Promise(res => setTimeout(res, 1000));
        retries--;
    }
}
if (!pool) {
    throw new Error("Could not connect to DB");
}

logger.log(`Connected to DB in ${Date.now() - now} ms`)
const demo_password = getEnv('MSSQL_PASSWORD')


await createSchema(pool).then(res => {
    logger.log(`Schema created successfully ${JSON.stringify(res)} in ${Date.now() - now} ms`);
}).catch((err: any) => {
    logger.error("Error creating schema:" + err);
});

const sinkUser = getEnv('MSSQL_CONSUMER_USERNAME')
const statementUser = getEnv('MSSQL_STATEMENT_CREATOR_USERNAME')
for (const user of [sinkUser, statementUser]) {
    await runQuery(pool, `
    BEGIN TRY
        drop login ${user};
    END TRY
    begin catch
    end catch`)
    await runQuery(pool, `CREATE LOGIN ${user} WITH PASSWORD = '${demo_password}'`)
    await runQuery(pool, `CREATE USER ${user} FOR LOGIN ${user}`);
}
await runQuery(pool,`ALTER ROLE ${statementCreatorRole} ADD MEMBER ${statementUser};`);
await runQuery(pool,`ALTER ROLE ${sinkRole} ADD MEMBER ${sinkUser};`);

// TODO: make this configurable
await runQuery(pool,`
    EXECUTE sp_configure 'show advanced options', 1;
    RECONFIGURE;
    EXEC sp_configure 'max server memory (MB)', 8000000;
    RECONFIGURE;
    CREATE LOGIN [my_admin] WITH PASSWORD = '${demo_password}';
    ALTER SERVER ROLE sysadmin ADD MEMBER [my_admin];
    CREATE USER [my_admin] FOR LOGIN [my_admin];
    ALTER ROLE db_owner ADD MEMBER [my_admin];
`);



pool.close()
