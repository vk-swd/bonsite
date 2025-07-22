import { getEnv } from "./common/utils.js";
import { KClient } from "./common/kafka_client.js";

// import { sql } from '@types/mssql'; // Assuming you have a SQL library that supports TypeScript

import { createSchema } from "./common/db_defines.js";


const kafka_client = new KClient({ 
    name: getEnv("HOSTNAME"), 
    brokers: [getEnv("KAFKA_BROKERS")] 
});

/* When the service crashes it will restart consumption from the last offset on recovery. 
    What needs to be handled is the connectivity issues - manage offset counter
    in the controller and retry connections if they fail.
*/

/* CAN KAFKA CLIENT CONSUME UNORDERED MESSAGES?
    UNLIKELY WITH TCP CONNECTIONS + order guarantee per partition.
*/
import * as kf from "kafkajs";
import { time } from "console";
kafka_client.subscribe(
    [[getEnv("KAFKA_TOPICS_TRANSACTION_RESULTS"),0], [getEnv("KAFKA_TOPICS_TRANSACTIONS"),0]],
    async (pl: kf.EachBatchPayload) => {
        const { topic, partition, messages } = pl.batch;
        // pl.resolveOffset(pl.batch.lastOffset())
        
        console.log(`Received messages: ${messages.map(m => m.value?.toString()).join(';')} with last offset: 
            ${pl.batch.lastOffset()} at topic ${topic} partition ${partition} 
            uncommited: ${JSON.stringify(pl.uncommittedOffsets())}`);
    }
);


/*
kafka client consumes
mssql client writes
the results of mssql crites define how i commit consumption
connect to mssql
take the topic offset
start consuming from that offset
    what if i loose some messages in between? i can't because the connection is tcp.

for now let's try to consume anything at least first.

i guess reconnection should not be handled by kafka client, as well as commited offsets.
It should be handled by a controller that runs kafka client.

Actually...should i commit anything at all? 
can't i just remember last offset and then read from it upon reconnection?
actually that's exactly what i should do...


what do i do if the connection to the database drops and i need to buffer messages for a while?
i think i should be able to manually reset the offset to the last commited message.
    or i could actually unsubscripe to both topics when i loose the connection to the database.
*/


