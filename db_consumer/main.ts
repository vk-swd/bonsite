import { getEnv, last } from "./common/utils.js";
import { KConsumer } from "./common/kafka_client.js";

import * as kf from "kafkajs";

import { UserConnection } from "./common/db_defines.js";
import { Transaction, TransactionResult, TransactionResultValidator, TransactionValidator } from "./common/event_types.js";
import { logger } from "./common/logger.js";
import { ZodSchema } from "zod";


const db_connection = await UserConnection.create().catch(e => {
    logger.error(`Failed to connect to database: ${e}`);
    process.exit(1);
});

const clientId = `C0_${getEnv("HOSTNAME")}`
const kafka_client = new kf.Kafka({
    // No quotas and authentication/acl => no clientid and ssl/sasl
    clientId,
    brokers: [getEnv("KAFKA_BROKERS")]
})

const topic_transaction_res = getEnv("KAFKA_TOPICS_TRANSACTION_RESULTS");
const topic_transactions = getEnv("KAFKA_TOPICS_TRANSACTIONS")


/*  Order of transactions is not guaranteed.
    Write transactions and results as they come for failure resistance.
*/
function parseMsgs<T>(msgs: kf.Message[], validator: ZodSchema<T>) : T[] {
    return msgs.map(m => validator.parse(JSON.parse(m.value!.toString()) as T)) as T[];
}
const consumer = KConsumer.subscribe(kafka_client,
    [[topic_transactions,0], [topic_transaction_res,0]],
    async (pl: kf.EachBatchPayload) => {
        pl.resolveOffset(pl.batch.lastOffset())
        const { topic, partition, messages } = pl.batch;
        if (pl.isStale()) {
            logger.log(`Batch at offset ${last(messages)?.offset} is stale for topic ${topic} partition ${partition}`);
            return;
        }
        if (messages.length == 0) {
            logger.log(`No messages in batch for topic ${topic} partition ${partition}`);
            return;
        }
        try {
            let msgs: { type: "t", r: Transaction[] } | { type: "r", r: TransactionResult[] } =
                topic == topic_transactions ? 
                    { type: "t", r: parseMsgs<Transaction>(messages, TransactionValidator) } :
                    { type: "r", r: parseMsgs<TransactionResult>(messages, TransactionResultValidator) };
            db_connection.writeTransactionAndOffsetTransactionally(
                msgs,
                1,
                pl.batch.lastOffset(),
                partition,
                topic
            ).catch(e => {
                /*
                    The whole consumption is implemented as 
                        1) connect to sql
                        2) get offset
                        3) connect to kafka
                        4) consume from offset
                        5) write to sql and commit offset"
                    If the chain breaks at any point, the service could be restarted entirely.
                */
                logger.error(`Failed to write transaction results: ${e}`);
            });
        } catch (e) {
            logger.error(`Failed to parse messages: ${e}`);
        }
    }
).catch(e => {
    // TODO: restart service to retry connection or let some supervisor handle the problem.
    logger.error(`Failed connection to kafka.....${e}`)
});

