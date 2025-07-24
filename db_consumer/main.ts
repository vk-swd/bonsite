import { getEnv } from "./common/utils.js";
import { KConsumer } from "./common/kafka_client.js";

import * as kf from "kafkajs";

import { UserConnection } from "./common/db_defines.js";
import { Transaction, TransactionResult, TResult } from "./common/event_types.js";


const db_connection = await UserConnection.create().catch(e => {
    console.error(`Failed to connect to database: ${e}`);
    process.exit(1);
});

const clientId = `C0_${getEnv("HOSTNAME")}`
const kafka_client = new kf.Kafka({
    // No quotas and authentication/acl => no clientid and ssl/sasl
    clientId,
    brokers: [getEnv("KAFKA_BROKERS")]
})
/* When the service crashes it will restart consumption from the last offset on recovery. 
    What needs to be handled is the connectivity issues - manage offset counter
    in the controller and retry connections if they fail.
*/

/* CAN KAFKA CLIENT CONSUME UNORDERED MESSAGES?
    UNLIKELY WITH TCP CONNECTIONS + order guarantee per partition.
*/
const topic_transaction_res = getEnv("KAFKA_TOPICS_TRANSACTION_RESULTS");
const topic_transactions = getEnv("KAFKA_TOPICS_TRANSACTIONS")
const transactions = new Map<number, { t: Transaction, res?: TResult}>()
let minId = 0;
let maxId = 0;
// Here I will assume a system that for every transaction will create a result and
// it is impossible for one record to exist without the other.
// ALso the consumption is done in such a way to only commit the offset when both
// transaction and result are processed, so no gaps should be cause by any kind of failure.
// I don't actually need to expect that message ids are sequential, or wait
// for gaps in id sequence to be filled, because Kafka guarantees order and that no
// messages are lost.
// I can wait for results and commit the offset for a transaction for which that result arrived.




/*  Order of transactions is not preserved...kafka just guarantees that messages are consumed in the order they were produced
    So I need to buffer transactions and results until I have both for a given id.
    But i don't want to do it because i can't guarantee that if I when i receive a 
    result for a transaction, the transactions before it are all marked and i can move the offset.
    So I will just consume the messages and write them to the database, but I will keep the 
    result as undefined and update it later. It will sol system down a bit because data lookup will have to be made,
    but it will be more robust to failures and simpler to implement.
*/
const consumer = KConsumer.subscribe(kafka_client,
    [[topic_transactions,0], [topic_transaction_res,0]],
    async (pl: kf.EachBatchPayload) => {
        pl.resolveOffset(pl.batch.lastOffset())
        const { topic, partition, messages } = pl.batch;
        if (messages.length == 0) {
            console.log(`No messages in batch for topic ${topic} partition ${partition}`);
            return;
        }
        let msgs: (Transaction | TransactionResult)[] = [];
        try {
            msgs = messages.map(m => JSON.parse(m.value?.toString()!)) as (Transaction | TransactionResult)[];
        } catch (e) {
            console.error(`Failed to parse messages: ${e}`);
            // can save unresolved messages in special storage but this might just be an overkill here
        }
        db_connection.writeTransactionAndOffsetTransactionally(
            topic == topic_transaction_res ? {type: "r", r: msgs as TransactionResult[]} : {type: "t", r: msgs as Transaction[]},
            1,
            pl.batch.lastOffset(),
            0,
            topic_transactions
        ).catch(e => {
            console.error(`Failed to write transaction results: ${e}`);
        });
        console.log(`Received messages: ${messages.map(m => m.value?.toString()).join(';')} with last offset: 
            ${pl.batch.lastOffset()} at topic ${topic} partition ${partition} 
            uncommited: ${JSON.stringify(pl.uncommittedOffsets())}`);
    }
).catch(e => {
    // TODO: restart service to retry connection or let some supervisor handle the problem.
    console.error(`Failed connection to kafka.....${e}`)
});


/*
kafka client consumes
mssql client writes
the results of mssql crites define how i commit consumption
connect to mssql
take the topic offset
start consuming from that offset
    what if i loose some messages in between? i can't because the connection is tcp.

for now let's try to consume anything at least first.


what do i do if the connection to the database drops and i need to buffer messages for a while?
i think i should be able to manually reset the offset to the last commited message.
    or i could actually unsubscripe to both topics when i loose the connection to the database.
*/


