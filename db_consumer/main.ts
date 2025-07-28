import { getEnv, KConsumerOffsetInfo, last } from "./common/utils.js";
import { KConsumer } from "./common/kafka_client.js";

import * as kf from "kafkajs";

import { Offsets, UserConnection } from "./common/db_defines.js";
import { Transaction, TransactionResult, TransactionResultValidator, TransactionValidator } from "./common/event_types.js";
import { logger } from "./common/logger.js";
import { ZodSchema } from "zod";
import * as mtrx from "./monitoring_local.js";
import { exit } from "process";


const monitoring = new mtrx.MonitoringServer(async () => {
}, await mtrx.localReg);


const MAGIC_CRUSH_NUMBER = 42;
async function crash() {
    mtrx.crashCount?.inc(1)
    await mtrx.dumpRegistry();
    logger.log("Pre-crash wrap up done, exiting...");
    exit(MAGIC_CRUSH_NUMBER);
}


const topic_transaction_res = getEnv("KAFKA_TOPICS_TRANSACTION_RESULTS");
const topic_transactions = getEnv("KAFKA_TOPICS_TRANSACTIONS")
const gropuId = getEnv("KAFKA_GROUP_ID");

async function runConsumption() {
    const db_connection = await UserConnection.create().catch(e => {
        logger.error(`Failed to connect to database: ${e}`);
        throw new Error(`Failed to connect to database: ${e}`);
    });

    const clientId = `C0_${getEnv("HOSTNAME")}`
    const kafka_client = new kf.Kafka({
        // No quotas and authentication/acl => no clientid and ssl/sasl
        clientId,
        brokers: [getEnv("KAFKA_BROKERS")]
    })

    /*  Order of transactions is not guaranteed.
        Write transactions and results as they come for failure resistance.
    */
    function parseMsgs<T>(msgs: kf.Message[], validator: ZodSchema<T>): T[] {
        return msgs.map(m => validator.parse(JSON.parse(m.value!.toString()) as T)) as T[];
    }
    const consumer = await KConsumer.subscribe(kafka_client, gropuId,
        [topic_transactions, topic_transaction_res],
        async (partitions: KConsumerOffsetInfo[]) => {
            let offset: Offsets | undefined;
            try {
                offset = await db_connection.getOffsets(gropuId, partitions);
            }
            catch (e) {
                mtrx.disconnectCount?.inc(1);
                logger.error(`Failed to get offsets from database: ${e}`);
                crash();
            }
            partitions.forEach(p => {
                p.partitions.forEach(partition => {
                    // If no offset is provided, start from the beginning
                    // It might cause overconsumption with a very long history.
                    // This can be fixed if offsets are commited to kafka occasionally,
                    // but this is not going to be implemented in the demo...yet
                    partition.offset = offset?.getOffset(p.topic, partition.id);
                });
            })
            return partitions;
        },
        async (pl: kf.EachBatchPayload) => {
            const { topic, partition, messages } = pl.batch;
            if (pl.isStale()) {
                logger.log(`Batch at offset ${last(messages)?.offset} is stale for topic ${topic} partition ${partition}`);
                return;
            }
            if (messages.length == 0) {
                logger.log(`No messages in batch for topic ${topic} partition ${partition}`);
                return;
            }
            let msgs: { type: "t", r: Transaction[] } | { type: "r", r: TransactionResult[] };
            try {
                msgs = topic == topic_transactions ?
                        { type: "t", r: parseMsgs<Transaction>(messages, TransactionValidator) } :
                        { type: "r", r: parseMsgs<TransactionResult>(messages, TransactionResultValidator) };
            } catch (e) {
                /*  Malformed messages may be the result of:
                        1) Some mismatch of message format between producer and consumer
                        2) Some data corruption, from tampering or natural causes
                    The first case should be caught during testing and deployment and is unlikely 
                    in a controlled setup like this.
                    The second case is rare, and such corruption is expected to affect 
                    only a small number of records.
                    Given all this it is more reasonable to keep posting those 
                    messages to the database as raw data for later inspection.
                    But to avoid unnecessary complexity no further recovery or quarantine 
                    logic will be implemented.
                    This is acceptable in a static demo project where such issues are improbable.
                */
               crash();
            }
            try {
                await db_connection.writeTransactionAndOffsetTransactionally(
                    msgs!,
                    gropuId,
                    pl.batch.lastOffset(),
                    partition,
                    topic
                )
            } catch (e) {
                logger.error(`Failed to parse messages: ${e}`);
                if (!db_connection.isConnectionAlive()) {
                    /*  Database connection is dead, restarting service
                        No point to consume when we can't write to database so wrap everything up and retry connection.
                    */
                    mtrx.disconnectCount?.inc(1);
                    logger.error(`Database connection is dead, restarting service...`);
                    crash();
                } else {
                    logger.error(`Database connection is alive, but failed to write messages: ${e}`);
                    /*  Not sure how to handle this or if it is even possible.
                        If that happens it is probably a problem with the database itself
                        and at least I should try to reconnect and redo the whole thing.
                        
                        During the reconnection, if there are multiple consumers, some other consumer
                        might be more successful in processing this batch. If it doesn't, then 
                        at least other partition processing will not get stuck.

                        Failure to write a message to a database could be caused by unsupported 
                        schema, which makes this instance of consumer effectively inoperable
                        for at least one partition. It still can process others, but handling 
                        rebalancing in place of Kafka controller is beyond the scope of this demo.
                        Instead I will report the failure and restart - this might help when there
                        are many consumers - some of them might be able to process the batch.
                        
                        The message could be saved to a generic table for later inspection, but it would
                        not make much sense, since such problems are expected to be rare and addressed fast,
                        so might as well just store them in Kafka.
                    */
                    crash();
                }
            }
            pl.resolveOffset(pl.batch.lastOffset());
        }
    ).catch(e => {
        // TODO: restart service to retry connection or let some supervisor handle the problem.
        logger.error(`Failed connection to kafka.....${e}`)
    });
}

runConsumption().catch(e => {
    logger.error(`Failed to reconnect to kafka: ${e}`);
    // retryConnection();
});

let retryTimer: NodeJS.Timeout | undefined = undefined
function retryConnection() {
    if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
    }
    retryTimer = setTimeout(() => {
        runConsumption().catch(e => {
            logger.error(`Failed to reconnect to kafka: ${e}`);
            retryConnection();
        });
    }, 5000);
}
