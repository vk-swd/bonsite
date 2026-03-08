import { getEnv } from "../common/utils.js";
import { initializeDatabase } from "../common/db/init.js";
import { logger } from "../common/logger.js";
import { statementDbName } from "../common/db/auth.js";

logger.log(`1`)
const now = Date.now();
const user_sa = getEnv('DB_INITIALIZER_MSSQL_SA_USERNAME')
const passwd_sa = getEnv('DB_INITIALIZER_MSSQL_SA_PASSWORD')
const password = getEnv('DB_INITIALIZER_MSSQL_OTHER_PASSWORDS')
const hostname = getEnv('DB_INITIALIZER_MSSQL_HOSTNAME')

logger.log(`Starting DB initialization at ${new Date(now).toISOString()}`)
let retries = 100;
let initialized = false;
while (retries > 0) {
    if (await initializeDatabase(user_sa, passwd_sa, hostname, password, statementDbName)) {
        logger.log(`Database initialized successfully in ${Date.now() - now} ms`);
        initialized = true;
        break;
    }
    logger.log(`Waiting for DB to be ready... ${retries} retries left. Error: `);
    await new Promise(res => setTimeout(res, 1000));
    retries--;
}

if (!initialized) {
    throw new Error("Could not connect to DB");
}