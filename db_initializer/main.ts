import { getEnv } from "./common/utils.js";
import { connectToDatabase } from "./common/db/common.js";
import { createSchema } from "./common/db/init.js";
import { logger } from "./common/logger.js";

const now = Date.now();
const user_sa = getEnv('MSSQL_SA_USERNAME')
const pool = await connectToDatabase(user_sa)!;
createSchema(pool).then(res => {
    logger.log(`Schema created successfully ${JSON.stringify(res)} in ${Date.now() - now} ms`);
}).catch((err: any) => {
    logger.error("Error creating schema:" + err);
});
pool.close()
