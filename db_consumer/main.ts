import { getEnv, KConsumerOffsetInfo, last } from "./common/utils.js";

import * as kf from "kafkajs";

import { ConnectionError, ConnectionErrorType, Offsets, UserConnection } from "./common/db/db_defines.js";
import { InKafkaMessage, MetadataWrapperValidator, Transaction, TransactionMessages, TransactionResult, TransactionResultValidator, TransactionValidator } from "./common/event_types.js";
import { logger } from "./common/logger.js";
import { ZodSchema } from "zod";
import * as mtrx from "./monitoring_local.js";



const MAGIC_CRUSH_NUMBER = 42;
let exiting = false;
async function crash(error: any): Promise<Error>{
    exiting = true;
    mtrx.metrics?.crashCount?.inc(1)
    await mtrx.dumpRegistry();
    logger.log("Pre-crash wrap up done, exiting...");
    throw error
}


// const topic_transaction_res = getEnv("KAFKA_TOPICS_TRANSACTION_RESULTS");
// const topic_transactions = getEnv("KAFKA_TOPICS_TRANSACTIONS")
const groupId = getEnv("KAFKA_GROUP_ID");
const topics = [getEnv("KAFKA_TOPICS_TRANSACTION_RESULTS"), getEnv("KAFKA_TOPICS_TRANSACTIONS")];
const [topic_transaction_res, topic_transactions] = topics;

/**
 * Parses messages from Kafka and validates them against the provided Zod schema.
 * There are two types of messages: Transaction and TransactionResult, 
 *  both have Zod schemas defined in common/event_types.ts.
 * @param msgs - Array of Kafka messages to parse.
 * @param validator - Zod schema to validate the parsed messages.
 * @returns Array of validated messages.
 */
function parseMsgs<T>(msgs: string[], validator: ZodSchema<T>): T[] {
    return msgs.map(m => validator.parse(JSON.parse(m) as T)) as T[];
}


/**
 * One of callbacks provided on consumer subscription.
 * 
 * Its purpose is to 
 *  1) Gather topic partition numbers assigned during Kafka rebalancing
 *  2) Request last saved offsets in the database
 *  3) Return offsets information.
 * Partitions can be assigned manually with custom assigner,
 * but this approach is less centralized and potentially unreliable.
 * It is not used in this demo.
 * 
 * Normally Kafka controller manages offsets himself, but in this demo
 * offsets are stored in the same database the consumer writes to for faster writes.
 * 
 * If no offset is provided, it will start from the beginning.
 * It might cause overconsumption if the offsets failed 
 * to be read and the message log is very long.
 * This can be fixed if offsets are commited to kafka occasionally,
 * but this is not going to be implemented in the demo.
 * Especially because this is an unlikely scenario in a controlled setup like this.
 * 
 * @param partitions - Array of KConsumerOffsetInfo objects received after 
 * rebalancing, for which offsets should be provided.
 * @returns Updated "partitions" argument with offsets.
 * 
 * @exceptions This function is provided as a callback, so there is no way to 
 * explicitly handle exceptions generated from here. Yet this application
 * is expected to close and restart when any database connectivity errors occur.
 * "getOffsets" might also throw for other reasons, like database schema mismatch,
 * but this will not be handled in this demo.
 */
export async function getOffsetsWhenPartitionsAssigned(
    partitions: KConsumerOffsetInfo[], 
    db_connection: UserConnection): Promise<Offsets>
{
    try {
        return await db_connection.getOffsets(groupId, partitions);
    }
    catch (e) {
        mtrx.metrics?.dbDisconnectCount?.inc(1);
        logger.error(`Failed to get offsets for ${JSON.stringify(partitions)}: ${e}`);
    }
    return Offsets.empty();
}

/**
 * The callback function a Kafka consumer uses to process each batch of messages.
 * Used by {@link runConsumption}.
 * @param pl - EachBatchPayload object received from Kafka consumer.
 * @returns 
 * 
 *  if the srevice is unable to write data to the database, then
 * it will log the error and crash the service.
 */
export async function processConsumedBatch(topic: string, partition: number, messages: string[], lastOffset: string, db_connection: UserConnection) {
    if (messages.length == 0) {
        logger.log(`No messages in batch for topic ${topic} partition ${partition}`);
        return;
    }
    let msgs: TransactionMessages;
    mtrx.metrics?.kafkaIncomingMessageCount?.inc(messages.length);
    try {
        const kMsgs = parseMsgs<InKafkaMessage>(messages, MetadataWrapperValidator)
        msgs = { type: topic == topic_transactions ? "t" : "r", r: kMsgs };
    } catch (e) {
        /*  Version mismatch between producer and consumer or data corruption/tampering.
            Don't block service, save for later inspection.
        */
        msgs = { type: "e", r: messages };
        mtrx.metrics?.kafkaParseFailure?.inc(msgs.r.length);
        logger.error(`Failed to parse messages: ${msgs.r} for topic ${topic} partition ${partition}: ${e}`);
    }
    let resend = true;
    while (resend) {
        try {
            const res = await db_connection.writeTransactionAndOffsetTransactionally(
                msgs!,
                groupId,
                lastOffset,
                partition,
                topic)
            if (res.rolledBack) {
                mtrx.metrics?.dbRollbackCount?.inc(1);
                if (msgs!.type == "e") {
                    const msg = `Failed to write raw data for topic ${topic} partition ${partition} with offset ${lastOffset}`
                    logger.error(msg);
                    throw await crash(msg);
                } else {
                    mtrx.metrics?.dbRollbackCount?.inc(1);
                    msgs = { type: "e", r: messages };
                    logger.error(`Transaction rolled back for topic ${topic} partition ${partition} with offset ${lastOffset}`);   
                }
            } else {
                mtrx.metrics?.dbKnownMessageWritten?.inc(res.duds);
                mtrx.metrics?.dbUnknownMessageWritten?.inc(res.newCount);
                resend = false;
                logger.log(`Successfully wrote ${messages.length} messages to topic ${topic} partition ${partition} with offset ${lastOffset}`);
            }
        } catch (e) {
            const msg = `batch for topic ${topic} partition ${partition} with ${messages.length} messages offset ${lastOffset} `;
            if (!(e instanceof ConnectionError)) {
                logger.error(`Unknown exception when writing (${msg}) to database: ${JSON.stringify(e)}`);
                throw await crash(e);
            } else if (e.type === ConnectionErrorType.TRANSACRION_ERROR) {
                mtrx.metrics?.dbDisconnectCount?.inc(1);
                logger.error(`Lost connection to database while writing (${msg}): ${e.message}`);
                throw await crash(e);
            } else {
                logger.error(`Failed to write (${msg}) of type ${msgs!.type} : ${e.message}`);
                mtrx.metrics?.dbQueryFailure?.inc(messages.length);
                throw await crash(e);
            }
        }
    }
}

/** Starts consuming messages from Kafka and processing them.
    The whole consumption is implemented as 
        1) connect to sql
        2) connect to kafka
        3) get partition offsets @see getOffsetsWhenPartitionsAssigned
        4) start consumption from the offsets
        5) On repeat: consume message, write it to sql and commit offset
                        @see processConsumedBatch for more details.
    If the chain breaks at any point, then:
        1) If database is unreachable - nowhere to write messages, no point to consume - exit.
        2) If Kafka is unreachable - nothing to cunsume - exit.
        3) Wrong messages arrive - save them for later in raw text and notify -
                                    don't block other message/partition processing
        4) Can't write to database - means even raw data write failed,
                                    most likely a critical schema mismatch, 
                                    the service or the database must be redeployed.
    When processing critical information, like financial transactions, handling data inconsistencies
    automatically may cause data loss or corruption, hence raw data is saved for later inspection.
 */
async function connectToDb(): Promise<UserConnection> {
    try {
        return await UserConnection.create()
    } catch (e) {
        mtrx.metrics?.dbConnectionFailure?.inc(1);
        logger.error(`Failed to connect to database: ${e}`);
        throw await crash(e);
    }
}
function partitionInfoFromGroupJoinEvent(event: kf.ConsumerGroupJoinEvent): KConsumerOffsetInfo[] {
    return Object.entries(event.payload.memberAssignment)
        .map(([topic, partitions]) => ({
            topic, partitions
        } as KConsumerOffsetInfo));
}
async function assignOffsets(offsetInfo: KConsumerOffsetInfo[]
    , offsets: Offsets
    , consumer: kf.Consumer): Promise<void> {
    offsetInfo.forEach(o => {
        o.partitions.forEach(p => {
            const offset = offsets?.getOffset(o.topic, p);
            if (offset !== undefined) {
                consumer.seek({ topic: o.topic, partition: p, offset });
            }
        });
    })   
}
async function connectToKafka(db_connection: UserConnection): Promise<kf.Consumer> {
    const kafka_connect_conf = {
        clientId: `C0_${getEnv("HOSTNAME")}`,
        brokers: [getEnv("KAFKA_BROKERS")]
        // No quotas and authentication/acl => no clientid and ssl/sasl
    }
    const kafka_client = new kf.Kafka(kafka_connect_conf)
    const consumer_config = {
        groupId,
        allowAutoTopicCreation: true,
        sessionTimeout: 7000,
        heartbeatInterval: 2000
    };
    const consumer = kafka_client.consumer(consumer_config);
    consumer.on(`consumer.disconnect`, () => {
        if (!exiting) {
            logger.log(`Consumer lost connection`);
            mtrx.metrics?.kafkaDisconnectCount?.inc(1);
        }
    });
    consumer.on(`consumer.network.request_timeout`, () => {
        logger.log(`consumer.network.request_timeout`);
        mtrx.metrics?.kafkaRequestTimeout?.inc(1);
    });
    consumer.on('consumer.group_join', async (event: kf.ConsumerGroupJoinEvent) => {
        const offsetInfo = partitionInfoFromGroupJoinEvent(event);
        const offsets = await getOffsetsWhenPartitionsAssigned(offsetInfo, db_connection)
        assignOffsets(offsetInfo, offsets, consumer)
    });
    try {
        await consumer.connect()
    } catch (e) {
        mtrx.metrics?.kafkaConnectFailure?.inc(1);
        logger.error(`Failed to connect to kafka with config: `
            + `${kafka_connect_conf}; gropuId: ${groupId};`
            + `error: ${e}`);
        throw await crash(e);
    }
    logger.log(`Connected to kafka with config: ${JSON.stringify(kafka_connect_conf)}; groupId ${groupId}`);
    return consumer;
}
async function subscribeToKafka(consumer: kf.Consumer, db_connection: UserConnection): Promise<void> {
    try {
        await consumer.subscribe({ topics });
        await consumer.run({
            // Failed batch processing might cause the application to stop for restat.
            // Please see "processConsumedBatch" documentation notes for more details.
            eachBatch: async (batch) => {
                const { topic, partition, messages } = batch.batch;
                if (batch.isStale()) {
                    logger.log(`Batch at offset ${last(messages)?.offset} is stale for topic ${topic} partition ${partition}`);
                    return;
                }
                const messageStrings = messages.filter(m => m.value !== null).map(m => m.value!.toString());
                if (messageStrings.length != messages.length) {
                    logger.warn(`${messages.length - messageStrings.length} null messages at ${topic} : ${partition} : ${batch.batch.lastOffset()}`);
                }
                await processConsumedBatch(topic, partition, messageStrings, batch.batch.lastOffset(), db_connection)
                batch.resolveOffset(batch.batch.lastOffset());
            },
            autoCommit: false,
            eachBatchAutoResolve: false
        })
        console.log(`Consumer run successful`);
    } catch (e) {
        mtrx.metrics?.kafkaSubscribeFailure?.inc(1);
        logger.error(`Failed to subscribe to topics: ${topics.join(',')};`
            + `error: ${e}`);
        throw await crash(e);
    }
}
async function runConsumption() {
    await mtrx.startMonitoring()
    const db_connection: UserConnection = await connectToDb();
    const consumer: kf.Consumer = await connectToKafka(db_connection);
    await subscribeToKafka(consumer, db_connection);
}


const timeiout = setInterval(() => {
    // if (exiting) {
    //     clearInterval(timeiout);
        logger.log(`Exiting...`);
    // }
}, 10000);
