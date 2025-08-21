import { getEnv } from "./common/utils.js";

import * as kf from "kafkajs";

import { ConnectionError, ConnectionErrorType, Offsets, UserConnection } from "./common/db/db_defines.js";
import { InKafkaMessage, MetadataWrapperValidator, Transaction, TransactionMessages, TransactionResult, TransactionResultValidator, TransactionValidator } from "./common/event_types.js";
import { logger } from "./common/logger.js";
import { ZodSchema } from "zod";
import * as mtrx from "./monitoring_local.js";
import { HealthCheckSever } from "./common/healthcheck.js";
import { connectToKafka, subscribeToKafka, topic_transactions } from "./kafka_consumer.js";





// const topic_transaction_res = getEnv("KAFKA_TOPICS_TRANSACTION_RESULTS");
// const topic_transactions = getEnv("KAFKA_TOPICS_TRANSACTIONS")
export const groupId = getEnv("KAFKA_GROUP_ID");

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
    db_connection: UserConnection): Promise<Offsets>
{
    try {
        return await db_connection.getOffsets();
    } catch (e) {
        mtrx.metrics?.dbDisconnectCount?.inc(1);
        throw `Failed to get offsets from database: ${e}`
    }
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
    const batchInfo = () => `g:${groupId}, t:${topic}, p:${partition}, o: ${lastOffset}`;
    if (messages.length == 0) {
        logger.log(`No messages in ${batchInfo()}`);
        return;
    }
    let sendRaw = false;
    let msgs: InKafkaMessage[];
    mtrx.metrics?.kafkaIncomingMessageCount?.inc(messages.length);
    try {
        msgs = parseMsgs<InKafkaMessage>(messages, MetadataWrapperValidator)
    } catch (e) {
        /*  Version mismatch between producer and consumer or data corruption/tampering.
            Don't block service, save for later inspection.
        */
        sendRaw = true;
        mtrx.metrics?.kafkaParseFailure?.inc(messages.length);
        logger.error(`Failed to parse ${batchInfo()}: ${e}`);
    }
    const sendAsRaw = async () => {
        try {
            await db_connection.writeRawMessages(messages,
                groupId,
                lastOffset,
                partition,
                topic);
            mtrx.metrics?.dbUnknownMessageWritten?.inc(messages.length);
        } catch (e) {
            mtrx.metrics?.dbQueryFailure?.inc(messages.length);
            throw `Failed to write${batchInfo()} raw: ${e}`
        }
    }
    if (sendRaw) {
        await sendAsRaw();
        return;
    }
    const writer = topic === topic_transactions ? db_connection.sendTransactions.bind(db_connection)
        : db_connection.sendTransactionResults.bind(db_connection);
    try {
        const res = await db_connection.writeDataTransactionally(
            msgs!,
            writer,
            groupId,
            lastOffset,
            partition,
            topic)
        if (res.rolledBack) {
            // loss of connection will reveal itself during raw data write
            sendRaw = true;
            mtrx.metrics?.dbRollbackCount?.inc(1);
        } else {
            mtrx.metrics?.dbKnownMessageWritten?.inc(res.newCount);
            mtrx.metrics?.dbUnknownMessageWritten?.inc(res.duds);
        }
    } catch (e) {
        mtrx.metrics?.dbQueryFailure?.inc(messages.length);
        throw `Failed to write transaction data in ${batchInfo()}: ${JSON.stringify(e)}`
    }
    if (sendRaw) {
        await sendAsRaw();
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
        throw `Failed to connect to database: ${e}`
    }
}

export class Sink {
    static async create(): Promise<Sink> {
        const healthServer = new HealthCheckSever(false);
        await mtrx.startMonitoring()
        const db_connection: UserConnection = await connectToDb();
        const consumer: kf.Consumer = await connectToKafka(async (e: kf.ConsumerGroupJoinEvent) => {
            const offsets = await db_connection.getOffsets();
            console.log(`Consumer group join event: ${JSON.stringify(e)}`);
            return Array.from(Object.entries(e.payload.memberAssignment)).flatMap(o => {
                return o[1].map(p => ({
                    topic: o[0],
                    partition: p,
                    offset: offsets.getOffset(groupId, o[0], p) || "0"
                }))
            })
        }, () => {
            healthServer.isHealthy = true;
            logger.log(`Consumer is ready to process messages`);
        });
        await subscribeToKafka(consumer, async (t, p, msgs, o) => {
            await processConsumedBatch(t, p, msgs, o, db_connection);
        });
        return new Sink(db_connection, consumer, healthServer);
    }
    private constructor(public db_connection: UserConnection, 
        public consumer: kf.Consumer,
        public healthcheckServer: HealthCheckSever) {}
}

    