import { getEnv } from "./common/utils.js";
import { KClient } from "./common/kafka_client.js";

// import { sql } from '@types/mssql'; // Assuming you have a SQL library that supports TypeScript

import { createSchema } from "./common/db_defines.js";

createSchema().then(res => {
    console.log(`Schema created successfully ${JSON.stringify(res)}`);
}).catch((err: any) => {
    console.error("Error creating schema:", err);
});

// const kafka_client = new KClient({ 
//     name: getEnv("HOSTNAME"), 
//     brokers: [getEnv("KAFKA_BROKERS")] 
// });

// kafka_client.subscribe(getEnv("KAFKA_TOPIC"));
// kafka_client.subscribe("t1")
// kafka_client.consumer!.subscribe("t1")
// kafka_client.consumer!.subscribe("t1")
// kafka_client.consumer!.subscribe("t1")


