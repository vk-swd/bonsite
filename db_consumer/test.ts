import { createSchema, UserConnection } from './common/db_defines.js';
import { InKafkaMessage, Transaction, TransactionResult, TransactionResultValidator, TransactionValidator, TResult } from './common/event_types.js';
import { getEnv, last } from './common/utils.js';
import { processConsumedBatch } from './main.js';
import { describe, it } from 'mocha'
// addint as promised
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { exit } from 'process';
import { logger } from './common/logger.js';
chai.use(chaiAsPromised);
chai.config.includeStack = true;
chai.config.truncateThreshold = 10000

const groupId = getEnv("KAFKA_GROUP_ID");
const topics = [getEnv("KAFKA_TOPICS_TRANSACTION_RESULTS"), getEnv("KAFKA_TOPICS_TRANSACTIONS")];
const [topic_transaction_res, topic_transactions] = topics;

enum RecordStatus {
    IGNORED,
    PROCESSED
}
type Batch = { status: RecordStatus, t: InKafkaMessage, o: string }[];
function getIgnored<T>(batch: Batch): T[] {
    return batch.filter(b => b.status === RecordStatus.IGNORED)
                .map(b => b.t.payload as T);
}

function getReturnedTransactions(tBatches: Batch[], resBatches: Batch[]): Transaction[] {
    const res: Transaction[] = [];
    for (const tBatch of tBatches) {
        for (const tRecord of tBatch) {
            if (tRecord.status !== RecordStatus.PROCESSED) {
                continue;
            }
            let hasResult = false;
            const trans = tRecord.t.payload as Transaction;
            for (const resBatch of resBatches) {
                for (const resRecord of resBatch) {
                    const result = resRecord.t.payload as TransactionResult;
                    if (result.id !== trans.id
                        || resRecord.status !== RecordStatus.PROCESSED
                        || result.state !== TResult.CONFIRMED) {
                        continue;
                    }
                    res.push(trans);
                    hasResult = true;
                    break;
                }
                if (hasResult) {
                    break;
                }
            }            
        }
    }
    return res;
}

function sendBatch(topic: string, batch: Batch, db_connection: UserConnection) {
    const offset = last(batch)!.o;
    const messages = batch.map(b => JSON.stringify(b.t));
    return processConsumedBatch(topic, 0, messages, offset, db_connection);
}

const partitionsPerTOpic = [
    { topic: topic_transaction_res, partitions: [0] },
    { topic: topic_transactions, partitions: [0] }
];

async function testOffsets(topic: string, val: string, connection: UserConnection) {
    const offsets = await connection.getOffsets(groupId, partitionsPerTOpic);
    chai.expect(offsets.getOffset(topic, 0)??'0', `expected ${val} from ${topic}`).to.equal(val);
}

function dataToTransaction(data: string): Transaction {
    const parsed = JSON.parse(data);
    return TransactionValidator.parse({
        id: parsed.id,
        dateTime: new Date(parsed.dateTime).getMilliseconds(),
        amount: parsed.amount,
        userIdFrom: parsed.userIdFrom,
        userIdTo: parsed.userIdTo
    });
}
function dataToTransactionRes(data: string): TransactionResult {
    const parsed = JSON.parse(data);
    return TransactionResultValidator.parse({
        id: parsed.transactionID,
        dateTime: new Date(parsed.dateTime).getMilliseconds(),
        state: parsed.state as TResult
    });
}
describe('Kafka Consumer Tests', function () {
    this.timeout(10000); // Set timeout for the tests
    let db_connection: UserConnection | undefined = undefined
    this.beforeEach(async () => {
        await createSchema();
        try {
            db_connection = await UserConnection.create();
        } catch (e) {
            logger.error(`Failed to create database connection: ${e}`);
            exit(1);
        }
    }); 
    it(`Simple functional test`, async () => {
        let tIdx = 1;
        let rIdx = 1;
        const batches: Batch[] = [
            [
                { status: RecordStatus.PROCESSED,   t: {id: 1, dateTime: 110.0, amount: 1.00, userIdFrom: 0, userIdTo: 1}, o: `${tIdx++}` },
                { status: RecordStatus.IGNORED,     t: {id: 1, dateTime: 110.0, amount: 1.00, userIdFrom: 1, userIdTo: 1}, o: `${tIdx++}` },
                { status: RecordStatus.PROCESSED,   t: {id: 2, dateTime: 110.0, amount: 1.00, userIdFrom: 0, userIdTo: 1}, o: `${tIdx++}` },
                { status: RecordStatus.PROCESSED,   t: {id: 3, dateTime: 110.0, amount: 1.00, userIdFrom: 0, userIdTo: 1}, o: `${tIdx++}` },
                { status: RecordStatus.IGNORED,     t: {id: 3, dateTime: 110.0, amount: 1.00, userIdFrom: 1, userIdTo: 1}, o: `${tIdx++}` },
            ],
            [
                { status: RecordStatus.PROCESSED,   t: {id: 1, dateTime: 200, state: TResult.CONFIRMED}, o: `${rIdx++}` },
                { status: RecordStatus.IGNORED,     t: {id: 1, dateTime: 200, state: TResult.BLOCKED}, o: `${rIdx++}` },
                { status: RecordStatus.PROCESSED,   t: {id: 2, dateTime: 200, state: TResult.BLOCKED}, o: `${rIdx++}` },
                { status: RecordStatus.IGNORED,     t: {id: 2, dateTime: 200, state: TResult.CONFIRMED}, o: `${rIdx++}` },
                { status: RecordStatus.PROCESSED,   t: {id: 3, dateTime: 200, state: TResult.BLOCKED}, o: `${rIdx++}` },
            ],
            [
                { status: RecordStatus.IGNORED,     t: {id: 1, dateTime: 210.0, amount: 1.00, userIdFrom: 0, userIdTo: 1}, o: `${tIdx++}` },
                { status: RecordStatus.IGNORED,     t: {id: 1, dateTime: 210.0, amount: 1.00, userIdFrom: 1, userIdTo: 1}, o: `${tIdx++}` },
                { status: RecordStatus.IGNORED,     t: {id: 1, dateTime: 210.0, amount: 1.00, userIdFrom: 2, userIdTo: 1}, o: `${tIdx++}` },
                { status: RecordStatus.IGNORED,     t: {id: 3, dateTime: 210.0, amount: 1.00, userIdFrom: 0, userIdTo: 1}, o: `${tIdx++}` },
                { status: RecordStatus.IGNORED,     t: {id: 3, dateTime: 210.0, amount: 1.00, userIdFrom: 1, userIdTo: 1}, o: `${tIdx++}` },
                { status: RecordStatus.IGNORED,     t: {id: 3, dateTime: 210.0, amount: 1.00, userIdFrom: 2, userIdTo: 1}, o: `${tIdx++}` },
                { status: RecordStatus.PROCESSED,   t: {id: 4, dateTime: 210.0, amount: 1.00, userIdFrom: 0, userIdTo: 1}, o: `${tIdx++}` },
                { status: RecordStatus.IGNORED,     t: {id: 4, dateTime: 210.0, amount: 1.00, userIdFrom: 1, userIdTo: 1}, o: `${tIdx++}` },
                { status: RecordStatus.PROCESSED,   t: {id: 5, dateTime: 210.0, amount: 1.00, userIdFrom: 0, userIdTo: 1}, o: `${tIdx++}` },
                { status: RecordStatus.IGNORED,     t: {id: 5, dateTime: 210.0, amount: 1.00, userIdFrom: 1, userIdTo: 1}, o: `${tIdx++}` },
            ],
            [
                { status: RecordStatus.IGNORED,     t: {id: 2, dateTime: 220, state: TResult.CONFIRMED}, o: `${rIdx++}` },
                { status: RecordStatus.IGNORED,     t: {id: 3, dateTime: 220, state: TResult.CONFIRMED}, o: `${rIdx++}` },
                { status: RecordStatus.IGNORED,     t: {id: 1, dateTime: 220, state: TResult.BLOCKED}, o: `${rIdx++}` },
                { status: RecordStatus.PROCESSED,   t: {id: 4, dateTime: 220, state: TResult.CONFIRMED}, o: `${rIdx++}` },
                { status: RecordStatus.PROCESSED,   t: {id: 5, dateTime: 220, state: TResult.BLOCKED}, o: `${rIdx++}` },
            ]
        ].map(b => b.map(t => {
            return { status: t.status, 
                t: { metadata: { seqNumber: 0, isIgnored: false }, payload: t.t } as InKafkaMessage,
                o: t.o };
        }));

        function compareObjecs<T>(actual: T[], expected: T[], message: string) {
            const a = actual
            const e = expected;
            chai.expect(a, `expected ${e} but got ${a}`).to.deep.equal(e);
        }
        async function sendTransactions(tBatch: Batch, msg: string) {
            const expectedIgnored = getIgnored<Transaction>(tBatch).sort((a, b) => a.id - b.id);
            await sendBatch(topic_transactions, tBatch, db_connection!); 
            const ignored = (await db_connection!.getRawData(expectedIgnored.length))
                                                .map(r => dataToTransaction(r))
            compareObjecs(ignored, expectedIgnored, msg);
                
            await testOffsets(topic_transactions, last(tBatch)!.o, db_connection!);
        }
        async function sendTResults(resBatch: Batch, msg: string) {
            await sendBatch(topic_transaction_res, resBatch, db_connection!);
            const expectedIgnored = getIgnored<TransactionResult>(resBatch).sort((a, b) => a.id - b.id);
            const ignored = ((await db_connection!.getRawData(expectedIgnored.length))
                                                .map(r => dataToTransactionRes(r)));
            compareObjecs(ignored, expectedIgnored, msg);
            await testOffsets(topic_transaction_res, last(resBatch)!.o, db_connection!);
        }
        async function checkValidTransactions(tBatch: Batch[], resBatches: Batch[], msg: string) {
            const expectedReturned = getReturnedTransactions(tBatch, resBatches);
            const returned = await db_connection!.getTransactions(0);
            compareObjecs(returned, expectedReturned, msg);
        }   

        await sendTransactions(batches[0], `Sending transactions batch 0`);
        await sendTResults(batches[1], `Sending transaction results batch 1`);
        await checkValidTransactions([batches[0]], [batches[1]], `Checking valid transactions after batch 0 and 1`);
        
        await sendTransactions(batches[2], `Sending transactions batch 2`);
        await sendTResults(batches[3], `Sending transaction results batch 3`);
        await checkValidTransactions([batches[0], batches[2]], [batches[1], batches[3]], `Checking valid transactions after batch 2 and 3`);
    });
});
