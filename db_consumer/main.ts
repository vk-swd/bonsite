import { getEnv } from "./common/utils.js";
import { KClient } from "./common/kafka_client.js";

// import { sql } from 'mssql'
const sql = require('mssql')




const sqlConfig1 = {
    user: process.env.MSSQL_USER,
    password: process.env.MSSQL_PASSWORD,
    database: process.env.MSSQL_DB_NAME,
    server: process.env.MSSQL_HOSTNAME,
    pool: {
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000
    },
    // options: {
    //   encrypt: true, // for azure
    //   trustServerCertificate: false // change to true for local dev / self-signed certs
    // }
}


const test = (async () => {
    try {
        // make sure that any items are correctly URL encoded in the connection string
        await sql.connect(sqlConfig1)
        const result = await sql.query`select * from mytable where id = ${value}`
        console.dir(result)
    } catch (err) {
        // ... error checks
    }
})
test();
// const kafka_client = new KClient({ 
//     name: getEnv("HOSTNAME"), 
//     brokers: [getEnv("KAFKA_BROKERS")] 
// });

// kafka_client.subscribe(getEnv("KAFKA_TOPIC"));
// kafka_client.subscribe("t1")
// kafka_client.consumer!.subscribe("t1")
// kafka_client.consumer!.subscribe("t1")
// kafka_client.consumer!.subscribe("t1")


