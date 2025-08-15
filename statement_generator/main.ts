

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

import { UserConnection } from "./common/db_defines.js";
import { logger } from "./common/logger.js";
import { StatementGenApiServer } from "./api.js";
import { StatementParameters } from "./common/event_types.js";
import { HealthCheckSever } from "./common/healthcheck.js";



const db_connection: UserConnection = await UserConnection.create()

const api = new StatementGenApiServer(async (p: StatementParameters) => {
    try {
        const statement = await db_connection.getTransactions(p);
        return JSON.stringify(statement);
    } catch (error) {
        logger.error(`Error fetching progress: ${error}`);
        throw error;
    }
});


const healthCheckServer = new HealthCheckSever();


