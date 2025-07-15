import { getEnv } from "./common/utils.js";
// import { sql } from '@types/mssql'; // Assuming you have a SQL library that supports TypeScript

import { createSchema } from "./common/db_defines.js";

createSchema().then(res => {
    console.log(`Schema created successfully ${JSON.stringify(res)}`);
}).catch((err: any) => {
    console.error("Error creating schema:", err);
});
