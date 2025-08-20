/* To handle something as heavy as bank statement requests from many users 
(if we are talking about demoing a real life), 
then a single threaded app does not sound realistic thing to use.
I reasoned that high vlolume of frequent requests should be batched on the frontline,
before they go beyond someone who collect them. 
It means actual statement service will take a request for multiple users with multiple parameters,
build a database query and let the database do the lookups and data compilation. 
After it is done all that's required is to split it and send to a bundle of writing jobs, 
    which will be done in the background and trigger service upon full completion.
    The writing can be done straight to a mounted cdn location and unload the mssql service entirely
So looking at all that, using a nodejs orchestrator does not look to be all that nonsensical.*/

import { UserConnection } from "./common/db/db_defines.js";
import { logger } from "./common/logger.js";
import { StatementGenApiServer } from "./api.js";
import { StatementParameters } from "./common/event_types.js";
import { HealthCheckSever } from "./common/healthcheck.js";
import { getEnv } from "./common/utils.js";
import * as fs from 'fs';

let requestCount = 0;
const SHARED_DIR = getEnv('SHARED_DIR');

const db_connection: UserConnection = await UserConnection.create()

const api = new StatementGenApiServer(async (p: StatementParameters) => {
    const statement = await db_connection.getTransactions(p);
    console.log(`Statement for user ${p.userId} with params ${JSON.stringify(statement)}:`);
    const fileName = `statement-${requestCount++}-${Date.now()}.json`;
    return new Promise((resolve, reject) => {
        fs.writeFile(SHARED_DIR + "/" + fileName, JSON.stringify(statement), (err) => {
            if (err) {
                console.error(`Error writing stats to file ${fileName}:`, err);
                reject(err);
                return;
            }
            resolve(fileName);
        })
    })
});


const healthCheckServer = new HealthCheckSever();


