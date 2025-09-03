import { getEnv } from "./common/utils.js";
import { connectToDatabase } from "./common/db/common.js";
import { createSchema } from "./common/db/init.js";
import { logger } from "./common/logger.js";
import { runQuery } from "./common/db/common.js";
import { consumerUser as sinkUser, sinkRole, statementCreatorRole, statementUser, users } from "./common/db/auth.js";

const now = Date.now();
const user_sa = getEnv('MSSQL_SA_USERNAME')
const pool = await connectToDatabase(user_sa)!;
const demo_password = getEnv('MSSQL_PASSWORD')


await createSchema(pool).then(res => {
    logger.log(`Schema created successfully ${JSON.stringify(res)} in ${Date.now() - now} ms`);
}).catch((err: any) => {
    logger.error("Error creating schema:" + err);
});


for (const user of users) {
    await runQuery(pool, `
    BEGIN TRY
        drop login ${user.login};
    END TRY
    begin catch
    end catch`)
}
for (const user of users) {
    await runQuery(pool, `CREATE LOGIN ${user.login} WITH PASSWORD = '${demo_password}'`)
    await runQuery(pool, `CREATE USER ${user.name} FOR LOGIN ${user.login}`);
}
await runQuery(pool,`ALTER ROLE ${statementCreatorRole} ADD MEMBER ${statementUser.name};`);
await runQuery(pool,`ALTER ROLE ${sinkRole} ADD MEMBER ${sinkUser.name};`);



pool.close()
