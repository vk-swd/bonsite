import { getEnv } from "./common/utils.js";

import * as util from "util";
import * as kf from "kafkajs";

import { Offsets, UserConnection } from "./common/db/db_defines.js";
import { InKafkaMessage, MetadataWrapperValidator, Offset } from "./common/event_types.js";
import { logger } from "./common/logger.js";
import { ZodSchema } from "zod";
import * as mtrx from "./monitoring_local.js";
import { HealthCheckSever } from "./common/healthcheck.js";
import { connectToKafka, KafkaConnection, topic_transactions } from "./kafka_consumer.js";
import { QueryRes, SetUpTempTableProc, setUpTempTransactionResultsTable, setUpTempTransactionsTable } from "./common/db/procedures.js";
import { rawDataTable, statTable, transactionResultsTable, TransactionResultStored, transactionsTable, TransactionStored, usersTable } from "./common/db/tables.js";
import { assert } from "console";
import { off } from "process";





// const topic_transaction_res = getEnv("KAFKA_TOPICS_TRANSACTION_RESULTS");
// const topic_transactions = getEnv("KAFKA_TOPICS_TRANSACTIONS")
export const groupId = getEnv("KAFKA_GROUP_ID");
const DB_USER = getEnv("MSSQL_CONSUMER_USERNAME");

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
export async function processConsumedBatch(offset: Offset, messages: string[], dbSender: DbSender) {
    if (messages.length == 0) {
        logger.log(`No messages in`, offset);
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
        logger.error(`Failed to parse` , offset, ":", e);
    }
    if (sendRaw) {
        await dbSender.sendRaw(messages, offset);
        return;
    }
    const writer  = (offset.topic === topic_transactions ? setUpTempTransactionsTable
        : setUpTempTransactionResultsTable) as SetUpTempTableProc<TransactionStored|TransactionResultStored>;
    try {
        const res = await dbSender.sendMessagesTransactionally(
            writer,
            msgs!,
            offset
        );
        if (res.rolledBack === true) {
            // Loss of connection will reveal itself during raw data write
            sendRaw = true;
            mtrx.metrics?.dbRollbackCount?.inc(1);
        } else {
            mtrx.metrics?.dbKnownMessageWritten?.inc(res.newCount);
            mtrx.metrics?.dbUnknownMessageWritten?.inc(res.duds);
        }
    } catch (e) {
        mtrx.metrics?.dbQueryFailure?.inc(messages.length);
        throw new Error(util.format(`Failed to write transaction data in`, offset, ":", e));
    }
    if (sendRaw) {
        await dbSender.sendRaw(messages, offset);
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
        return await UserConnection.create("sa")
        // return await UserConnection.create(DB_USER)
    } catch (e) {
        mtrx.metrics?.dbConnectionFailure?.inc(1);
        throw `Failed to connect to database: ${e}`
    }
}

const DB_SIZE_LIMIT = 1024 * 1024 * 100; // 100 MB
export class DbSender {
    constructor(public connection: UserConnection, private sizeLimit: number = DB_SIZE_LIMIT) {}
    // TODO: move row rotation outside of "writeDataTransactionally"
    async sendRaw(messages: string[], oInfo: Offset): Promise<void> {
        // Not handling sendAsRaw exceptions, because raw table is a critical
        // fallback storage and failure to write to it means something is very wrong
        try {
            await this.connection.writeRawMessages(messages, oInfo);
            const rotated = await this.connection.rotateTableRows(messages.length);
            mtrx.metrics?.dbRowsRotated?.inc(rotated);
            mtrx.metrics?.dbUnknownMessageWritten?.inc(messages.length);
        } catch (e) {
            mtrx.metrics?.dbQueryFailure?.inc(messages.length);
            throw new Error(util.format(`Failed to write`, oInfo, ":", e));
        }
    }
    async sendMessagesTransactionally(tempTable: SetUpTempTableProc<TransactionResultStored | TransactionStored>,
            records: InKafkaMessage[],
            oInfo: Offset,
            triggerRollback: boolean = false
        ): Promise<QueryRes> {
        try {
            const res = await this.connection.writeDataTransactionally(tempTable, records, oInfo, triggerRollback);
            const rotated = await this.connection.rotateTableRows(records.length);
            mtrx.metrics?.dbRowsRotated?.inc(rotated);
            return res;
        } catch (e) {
            logger.error(`Failed to write`, oInfo, ":", e);
            throw e;
        }
    }
} 
export class Sink {
    static async create(): Promise<Sink> {
        const healthServer = new HealthCheckSever(false);
        // TODO: make persistent service (in the same container) 
        // where monitoring stats could be pushed on controlled crash
        await mtrx.startMonitoring()
        const dbSender = new DbSender(await connectToDb());
        const offsets = await dbSender.connection.getOffsets();
        const connection = await connectToKafka((topic: string, p: number) => {
            return offsets.getOffset(groupId, topic, p) || "0";
        }, async (msgs, o) => {
            await processConsumedBatch(msgs, o, dbSender);
        });
        logger.log(`Consumer is ready to process messages`);
        healthServer.isHealthy = true;
        return new Sink(dbSender, connection, healthServer);
    }
    private constructor(
        public db_connection: DbSender,
        public consumer: KafkaConnection,
        public healthcheckServer: HealthCheckSever) {}
}

