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
import { StatementGenApiServer } from "./api.js";
import { InKafkaMessage, StatementParameters } from "./common/event_types.js";
import { HealthCheckSever } from "./common/healthcheck.js";
import { getEnv } from "./common/utils.js";
import * as fsp from 'fs/promises';
import { boolean } from "zod";

let requestCount = 0;
const SHARED_DIR = getEnv('SHARED_DIR');

const db_connection: UserConnection = await UserConnection.create()

const api = new StatementGenApiServer(
    async (p: StatementParameters, success: (res: string) => void, fail: (err: string) => void) => {
        const fileName = `statement-${requestCount++}-${Date.now()}.json`;
        const handle = await fsp.open(SHARED_DIR + "/" + fileName, 'a') ;
        let error: string = "";
        let calledSuccess = false;
        try {
            await db_connection.streamSelectTransactions(p, 
                async (transaction: string) => {
                    try {
                        await handle.write(transaction + "\n")
                    } catch (e) {
                        error = `Error writing transaction to file ${fileName}: ${e}`;
                        await handle.close().catch();
                        throw error; // user catches it and stops the streaming
                    }
                }, async () => {
                    try {
                        await handle.close()
                        if (error.length == 0) {
                            success(fileName);
                            // `calledSuccess` indicates that the streaming finished successfully and all data
                            // has been written. 
                            // Once this is true, any other errors can be safely ignored.
                            calledSuccess = true;
                        }
                    } catch (e) {
                        error = `Error closing file ${fileName}: ${e}`;
                    }
                }
            )
        } catch (e) {
            error = `Error streaming transactions into file ${fileName}: ${e}`;
            if (!calledSuccess) {
                await handle.close().catch(_ => {});
            }
        }
        if (error.length > 0 && !calledSuccess) {
            fail(error);
        }
    }
);


const healthCheckServer = new HealthCheckSever();


