
import * as kf from "kafkajs";
import { getEnv, last } from "./common/utils.js";
import { logger } from "./common/logger.js";
import * as mtrx from "./monitoring_local.js";

const groupId = getEnv("KAFKA_GROUP_ID");

const topics = [getEnv("KAFKA_TOPICS_TRANSACTION_RESULTS"), getEnv("KAFKA_TOPICS_TRANSACTIONS")];
export const [topic_transaction_res, topic_transactions] = topics;

async function assignOffsets(offsets: kf.TopicPartitionOffset[],
    consumer: kf.Consumer): Promise<void> {
    offsets.forEach(o => consumer.seek(o))
}

export async function connectToKafka(getOffsets: (event: kf.ConsumerGroupJoinEvent) => Promise<kf.TopicPartitionOffset[]>, readyCb: () => void): Promise<kf.Consumer> {
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
    const admin: kf.Admin = kafka_client.admin({retry: {retries: 5}});
    await admin.connect();
    // ensure topics exist
    await admin.createTopics({ topics: topics.map(t => ({ topic: t, configEntries: [{ name: "retention.bytes", value: `${2 * 1024 * 1024 * 1024}`}] })) });
    const consumer = kafka_client.consumer(consumer_config);
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
    consumer.on('consumer.group_join', async (event: kf.ConsumerGroupJoinEvent) => {
        assignOffsets(await getOffsets(event), consumer)
        readyCb();
    });
    try {
        await consumer.connect()
    } catch (e) {
        mtrx.metrics?.kafkaConnectFailure?.inc(1);
        throw `Failed to connect to kafka with config: `
            + `${kafka_connect_conf}; gropuId: ${groupId};`
            + `error: ${e}`
    }

    logger.log(`Connected to kafka with config: ${JSON.stringify(kafka_connect_conf)}; groupId ${groupId}`);
    return consumer;
}
export async function subscribeToKafka(consumer: kf.Consumer, processBatch: (t: string, p: number, msgs: string[], o: string) => Promise<void>): Promise<void> {
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
                await processBatch(topic, partition, messageStrings, batch.batch.lastOffset())
                batch.resolveOffset(batch.batch.lastOffset());
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