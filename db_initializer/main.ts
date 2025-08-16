import { createSchema } from "./common/db/init.js";
import { logger } from "./common/logger.js";

const now = Date.now();
createSchema().then(res => {
    logger.log(`Schema created successfully ${JSON.stringify(res)} in ${Date.now() - now} ms`);
}).catch((err: any) => {
    logger.error("Error creating schema:" + err);
});
