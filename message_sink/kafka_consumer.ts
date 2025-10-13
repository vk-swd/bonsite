
import * as kf from "kafkajs";
import { Deferred, getEnv, last, RangeSet, sleep } from "./common/utils.js";
import { logger } from "./common/logger.js";
import * as mtrx from "./monitoring_local.js";
import { assert, log } from "console";
import { InKafkaMessage, Offset } from "./common/event_types.js";

const groupId = getEnv("KAFKA_GROUP_ID");

const topics = [getEnv("KAFKA_TOPICS_TRANSACTION_RESULTS"), getEnv("KAFKA_TOPICS_TRANSACTIONS")];
export const [topic_transaction_res, topic_transactions] = topics;

export async function connectToKafka(getOffset: (topic: string, partition: number) => string,
                                     processBatch: (offset: Offset, msgs: string[]) => Promise<void>): Promise<KafkaConnection> {
    const kafka_connect_conf = {
        clientId: `C0_${getEnv("HOSTNAME")}`,
        brokers: [getEnv("KAFKA_BROKERS")]
        // No quotas and authentication/acl => no clientid and ssl/sasl
    }
    const kafka_client = new kf.Kafka(kafka_connect_conf)
    const consumer_config = {
        groupId,
        allowAutoTopicCreation: true,
        sessionTimeout: 20000,
        heartbeatInterval: 2000,
        maxBytes: 300000,
        maxWaitTimeInMs: 100
    };
    const admin: kf.Admin = kafka_client.admin({retry: {retries: 5}});
    await admin.connect();
    // ensure topics exist
    await admin.createTopics({ topics: topics.map(t => ({ topic: t, configEntries: [{ name: "retention.bytes", value: `${2 * 1024 * 1024 * 1024}`}] })) });
    const res = new Deferred<KafkaConnection>();
    const consumer = kafka_client.consumer(consumer_config);
    const batchHistory = new Map<string, Array<number>>();
    consumer.on(`consumer.connect`, () => {
        // when the application is stopped normally,
        // this metric will not be saved or read, so don't
        // differenciate between (un)expected disconnects.
        logger.log(`Consumer connected`);
    });
    consumer.on(`consumer.rebalancing`, () => {
        // when the application is stopped normally,
        // this metric will not be saved or read, so don't
        // differenciate between (un)expected disconnects.
        logger.log(`Consumer consumer.rebalancing`);
    });
    consumer.on(`consumer.fetch`, (e: kf.ConsumerFetchEvent) => {
        mtrx.metrics?.kafkaMaxFetchDelay?.set(e.payload.duration);
    });
    consumer.on(`consumer.crash`, () => {
        // when the application is stopped normally,
        // this metric will not be saved or read, so don't
        // differenciate between (un)expected disconnects.
        logger.log(`Consumer crash`);
    });
    consumer.on(`consumer.disconnect`, () => {
        // when the application is stopped normally,
        // this metric will not be saved or read, so don't
        // differenciate between (un)expected disconnects.
        logger.log(`Consumer lost connection`);
        mtrx.metrics?.kafkaDisconnectCount?.inc(1);
    });
    consumer.on(`consumer.network.request_timeout`, () => {
        logger.log(`consumer.network.request_timeout`);
        mtrx.metrics?.kafkaRequestTimeout?.inc(1);
    });
    try {
        await consumer.connect()
        logger.log(`Connected to kafka with config: ${JSON.stringify(kafka_connect_conf)}; groupId ${groupId}`);
    } catch (e) {
        mtrx.metrics?.kafkaConnectFailure?.inc(1);
        throw `Failed to connect to kafka with config: `
            + `${kafka_connect_conf}; gropuId: ${groupId};`
            + `error: ${e}`
    }
    const connection =  new KafkaConnection(consumer, admin)
    consumer.on('consumer.group_join', async (joinEvent: kf.ConsumerGroupJoinEvent) => {
        for (const topic of Object.keys(joinEvent.payload.memberAssignment)) {
            logger.log(`seeking topic`, topic);
            const partitions = joinEvent.payload.memberAssignment[topic];
            for (let i = 0; i < partitions.length; i++ ) {
                const partition = partitions[i];
                assert(partition == i, `Expected partition ${partition} to be ${i}`);
                const offset = getOffset(topic, partition);
                if (offset && offset != "0") {
                    const meta = await admin.fetchTopicMetadata({topics})
                    logger.log(`Seeking topic`, topic, `partition`, partition, `to offset`, offset,
                        `meta: `, meta);
                    // KafkaJS requires offset to be a string representing a number
                    // await admin.deleteTopicRecords({ topic, partitions: [{partition, offset: (Number.parseInt(offset) - 1).toFixed(0)}] });
                    await admin.deleteTopicRecords({ topic, partitions: [{partition, offset}] });
                    consumer.seek({ topic, partition, offset });
                }
            }
            connection.sotrageCounter.set(topic, partitions.map(_ => ({ count: 0, lastOffsets: [] })));
        }
        connection.joinedTopics = Object.keys(joinEvent.payload.memberAssignment).map(t => ({ topic: t, partitions: joinEvent.payload.memberAssignment[t] }));
        
        res.resolve(connection);
    });
    consumer.subscribe({ topics });
    connection.subscribeToKafka(processBatch);
    return res.promise;
}

export class KafkaConnection {
    joinedTopics = new Array<{ topic: string; partitions?: number[] }>();
    pausedTopics = new Array<{ topic: string; partitions?: number[] }>();
    rangeSet = new RangeSet();
    paused = false;
    pauseBuffer = Array<kf.EachBatchPayload>();
    constructor(
        public consumer: kf.Consumer, 
        public admin: kf.Admin, 
        public sotrageCounter = new Map<string, Array<{count: number, lastOffsets: Array<number>}>>()) {
    
    }

    private processWhilePaused(processBatch: (offset: Offset, msgs: string[]) => Promise<void>, isStart: boolean = true): Promise<void> {
        if (this.pauseBuffer.length == 0) {
            this.consumer.resume(this.pausedTopics);
            this.paused = false;
            return Promise.resolve();
        }
        const batch = this.pauseBuffer.shift();
        const { topic, partition, messages } = batch!.batch;
        const lastBatchOffset = batch!.batch.lastOffset();
        const messagesFiltered = messages.filter(m => m.value !== null);
        if (messagesFiltered.length != messages.length) {
            // TODO: why would this happen 0_o?
            logger.warn(`${messages.length - messagesFiltered.length} null messages at ${topic} : ${partition} : ${lastBatchOffset}`);
        }
        if (messagesFiltered.length == 0) {
            batch!.resolveOffset(lastBatchOffset);
            this.processWhilePaused(processBatch);
            return Promise.resolve();
        }
        mtrx.metrics?.kafkaIncomingMessageCount?.inc(messagesFiltered.length);
        const lastOffset = messagesFiltered;
        if (lastBatchOffset != last(messagesFiltered)!.offset) {
            mtrx.metrics?.kafkaOldRecordsArrived?.inc(messagesFiltered.length);
            logger.log(`Strange offset order:`, lastOffset, ` vs`, lastBatchOffset);
        }
        const offset: Offset = { topic, partition, offset: lastBatchOffset, groupId };
        const now = Date.now();
        return processBatch(offset, messagesFiltered.map(m => m.value!.toString()))
        .then(() => {
            batch!.resolveOffset(lastBatchOffset);
            mtrx.metrics?.maxFetchProcessingDelayMs.set(Date.now() - now);
        })
        .catch((e) => {
            logger.error(`Failed to process batch at offset ${offset.offset} for topic ${topic} partition ${partition}; error: ${e}`);
        })
        .finally(() => {
            mtrx.metrics?.maxFetchFullProcessingDelayMs.set(Date.now() - now);
            this.processWhilePaused(processBatch, false);
        });
    }
    async subscribeToKafka(processBatch: (offset: Offset, msgs: string[]) => Promise<void>): Promise<void> {
        try {
            await this.consumer.run({
                // Failed batch processing might cause the application to stop for restat.
                // Please see "processConsumedBatch" documentation notes for more details.
                eachBatch: async (batch) => {
                    const { topic, partition, messages } = batch.batch;
                    if (batch.isStale()) {
                        logger.log(`Batch at offset ${last(messages)?.offset} is stale for topic ${topic} partition ${partition}`);
                        return;
                    }
                    this.pauseBuffer.push(batch);
                    if (this.paused) {
                        return;
                    }
                    this.pausedTopics = this.joinedTopics;
                    this.consumer.pause(this.pausedTopics);
                    this.paused = true;
                    this.processWhilePaused(processBatch);
                },
                autoCommit: false,
                eachBatchAutoResolve: false
            })
            console.log(`Consumer run successful`);
        } catch (e) {
            mtrx.metrics?.kafkaSubscribeFailure?.inc(1);
            throw `Failed to subscribe to topics: ${topics.join(',')};`
                + `error: ${e}`
        }
    }
}
