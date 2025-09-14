import { UserConnection } from './common/db/db_defines.js';
import { createSchema } from './common/db/init.js';
import { InKafkaMessage, Metadata, MetadataValidator, MetadataWrapperValidator, Transaction, TransactionResult, TransactionResultValidator, TransactionValidator, TResult } from './common/event_types.js';
import { getEnv, last, RangeSet, testRangeSet } from './common/utils.js';
import { groupId, processConsumedBatch } from './sink.js';
import { describe, it } from 'mocha'
// addint as promised
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { exit } from 'process';
import { logger } from './common/logger.js';
import { connectToDatabase } from './common/db/common.js';
import { parseQueryRes, RawTables, transactionResultsTable, transactionsTable } from './common/db/tables.js';
import { setUpTempTransactionResultsTable, setUpTempTransactionsTable } from './common/db/procedures.js';
chai.use(chaiAsPromised);
chai.config.includeStack = true;
chai.config.truncateThreshold = 10000

const topics = [getEnv("KAFKA_TOPICS_TRANSACTION_RESULTS"), getEnv("KAFKA_TOPICS_TRANSACTIONS")];
const [topic_transaction_res, topic_transactions] = topics;

const user_sa = getEnv('MSSQL_SA_USERNAME')
const TEST_DB_NAME = "TestDB";
enum DstTable {
    RAW,
    PRIMARY
}
type Batch = { dstTable: DstTable, t: InKafkaMessage, o: string }[];
function getIgnored<T>(batch: Batch): T[] {
    return batch.filter(b => b.dstTable === DstTable.RAW)
                .map(b => b.t.payload as T);
}

function getReturnedTransactions(tBatches: Batch[], resBatches: Batch[], user: number): Transaction[] {
    const results = new Map<number, [Transaction, TResult | undefined]>();

    tBatches.forEach(tBatch => tBatch.filter(r => r.dstTable == DstTable.PRIMARY).forEach(tRecord => {
        if (results.has(tRecord.t.payload.id)) {
            throw new Error(`Test is broken for transaction ${tRecord.t.payload.id}: only first transaction to arrive to the database whould be recorded in primary table.`);
        }
        results.set(tRecord.t.payload.id, [tRecord.t.payload as Transaction, undefined]);
    }));
    resBatches.forEach(resBatch => resBatch.filter(r => r.dstTable == DstTable.PRIMARY).forEach(resRecord => {
        const result = resRecord.t.payload as TransactionResult;
        if (!results.has(result.id)) {
            // records can be reordered and transaction record may come later.
            return;
        }
        const transaction = results.get(result.id)!;
        if (transaction[1] !== undefined) {
            throw new Error(`Test is broken for result of transaction ${result.id}: only first transaction result to arrive to the database whould be recorded in primary table.`);
        }
        transaction[1] = result.state;
    }));
    return Array.from(results.values())
        .filter(([t, state]) => state === TResult.CONFIRMED && (t.userIdFrom === user || t.userIdTo === user))
        .map(([transaction, _]) => transaction);
}

function sendBatch(topic: string, batch: Batch, db_connection: UserConnection) {
    const offset = last(batch)!.o;
    const messages = batch.map(b => JSON.stringify(b.t));
    return processConsumedBatch(topic, 0, messages, offset, db_connection);
}

async function testOffsets(topic: string, val: string, connection: UserConnection) {
    const offsets = await connection.getOffsets();
    chai.expect(offsets.getOffset(groupId, topic, 0)??'0', `expected ${val} from ${topic}`).to.equal(val);
}

async function sendTransactions(tBatch: Batch, msg: string) {
    const expectedIgnored = getIgnored<Transaction>(tBatch).sort((a, b) => a.id - b.id);
    await sendBatch(topic_transactions, tBatch, db_connection!);
    const ignored = (await db_connection!.getRawData(expectedIgnored.length, RawTables.transactions))
    const parsed = ignored.map(i => TransactionValidator.parse(parseQueryRes(i, transactionsTable.columns)));
    compareObjecs(parsed, expectedIgnored, msg);
        
    await testOffsets(topic_transactions, last(tBatch)!.o, db_connection!);
}
async function sendTResults(resBatch: Batch, msg: string) {
    await sendBatch(topic_transaction_res, resBatch, db_connection!);
    const expectedIgnored = getIgnored<TransactionResult>(resBatch).sort((a, b) => a.id - b.id);
    const ignored = ((await db_connection!.getRawData(expectedIgnored.length, RawTables.transaction_results)));
    const parsed = ignored.map(i => TransactionResultValidator.parse(parseQueryRes(i, transactionResultsTable.columns)));
    compareObjecs(parsed, expectedIgnored, msg);

    await testOffsets(topic_transaction_res, last(resBatch)!.o, db_connection!);
}
async function checkValidTransactions(tBatch: Batch[], resBatches: Batch[], user: number, msg: string) {
    const expectedReturned = getReturnedTransactions(tBatch, resBatches, user);
    const ts: Transaction[] = [];
    await db_connection!.getTransactions([{ userId: user }], async (userId: number, pidx: number, transaction: InKafkaMessage) => {
        ts.push(TransactionValidator.parse(transaction.payload));
    })
    compareObjecs(ts, expectedReturned, msg);
}
function compareObjecs<T>(actual: T[], expected: T[], message: string) {
    const a = actual
    const e = expected;
    chai.expect(a, message).to.deep.equal(e);
}
let db_connection: UserConnection | undefined = undefined
describe('Kafka Consumer Tests', function () {
    this.timeout(10000); // Set timeout for the tests
    this.beforeAll(async () => {
        const pool = await connectToDatabase(user_sa)!;
        // pool.request().query(`use ${TEST_DB_NAME}`);
        db_connection = new UserConnection(pool);
    });
    this.beforeEach(async () => {
        await createSchema(db_connection!.pool, "TestDB");
    });
    
    it(`Test normal case`, async () => {
        let tIdx = 1;
        let rIdx = 1;
        let tId = 0;
        let rId = 0;
        const batches: Batch[] = [
            [
                { dstTable: DstTable.PRIMARY, t: { id: tId++, dateTime: 110.0, amount: 1.00, userIdFrom: 0, userIdTo: 1 }, o: `${tIdx++}` },
                { dstTable: DstTable.PRIMARY, t: { id: tId++, dateTime: 111.0, amount: 1.00, userIdFrom: 1, userIdTo: 1 }, o: `${tIdx++}` },
                { dstTable: DstTable.PRIMARY, t: { id: tId++, dateTime: 112.0, amount: 1.00, userIdFrom: 0, userIdTo: 1 }, o: `${tIdx++}` },
                { dstTable: DstTable.PRIMARY, t: { id: tId++, dateTime: 113.0, amount: 1.00, userIdFrom: 0, userIdTo: 1 }, o: `${tIdx++}` },
                { dstTable: DstTable.PRIMARY, t: { id: tId++, dateTime: 114.0, amount: 1.00, userIdFrom: 1, userIdTo: 1 }, o: `${tIdx++}` },
            ],
            [
                { dstTable: DstTable.PRIMARY, t: { id: rId++, dateTime: 200, state: TResult.CONFIRMED }, o: `${rIdx++}` },
                { dstTable: DstTable.PRIMARY, t: { id: rId++, dateTime: 200, state: TResult.CONFIRMED }, o: `${rIdx++}` },
                { dstTable: DstTable.PRIMARY, t: { id: rId++, dateTime: 200, state: TResult.CONFIRMED }, o: `${rIdx++}` },
                { dstTable: DstTable.PRIMARY, t: { id: rId++, dateTime: 200, state: TResult.CONFIRMED }, o: `${rIdx++}` },
                { dstTable: DstTable.PRIMARY, t: { id: rId++, dateTime: 200, state: TResult.CONFIRMED }, o: `${rIdx++}` },
            ]
        ].map(b => b.map(t => {
            // Dud metadata records as completeness is not tested
            return { dstTable: t.dstTable, 
                t: { metadata: {}, payload: t.t } as InKafkaMessage,
                o: t.o };
        }));

        await sendTransactions(batches[0], `Sending transactions batch 0`);
        await sendTResults(batches[1], `Sending transaction results batch 1`);
        await checkValidTransactions([batches[0]], [batches[1]], 0, `Checking valid transactions after batch 0 and 1 for 0`);
        await checkValidTransactions([batches[0]], [batches[1]], 1, `Checking valid transactions after batch 0 and 1 for 1`);
    })
    it(`Test conflict handling`, async () => {
        let tIdx = 1;
        let rIdx = 1;
        const batches: Batch[] = [
            [
                { dstTable: DstTable.PRIMARY,   t: {id: 1, dateTime: 110.0, amount: 1.00, userIdFrom: 0, userIdTo: 1}, o: `${tIdx++}` },
                { dstTable: DstTable.RAW,       t: {id: 1, dateTime: 110.0, amount: 1.00, userIdFrom: 1, userIdTo: 1}, o: `${tIdx++}` },
                { dstTable: DstTable.PRIMARY,   t: {id: 2, dateTime: 110.0, amount: 1.00, userIdFrom: 0, userIdTo: 1}, o: `${tIdx++}` },
                { dstTable: DstTable.PRIMARY,   t: {id: 3, dateTime: 110.0, amount: 1.00, userIdFrom: 0, userIdTo: 1}, o: `${tIdx++}` },
                { dstTable: DstTable.RAW,       t: {id: 3, dateTime: 110.0, amount: 1.00, userIdFrom: 1, userIdTo: 1}, o: `${tIdx++}` },
            ],
            [
                { dstTable: DstTable.PRIMARY,   t: {id: 1, dateTime: 200, state: TResult.CONFIRMED}, o: `${rIdx++}` },
                { dstTable: DstTable.RAW,       t: {id: 1, dateTime: 200, state: TResult.BLOCKED}, o: `${rIdx++}` },
                { dstTable: DstTable.PRIMARY,   t: {id: 2, dateTime: 200, state: TResult.BLOCKED}, o: `${rIdx++}` },
                { dstTable: DstTable.RAW,       t: {id: 2, dateTime: 200, state: TResult.CONFIRMED}, o: `${rIdx++}` },
                { dstTable: DstTable.PRIMARY,   t: {id: 3, dateTime: 200, state: TResult.BLOCKED}, o: `${rIdx++}` },
            ],
            [
                { dstTable: DstTable.RAW,     t: {id: 1, dateTime: 210.0, amount: 1.00, userIdFrom: 0, userIdTo: 1}, o: `${tIdx++}` },
                { dstTable: DstTable.RAW,     t: {id: 1, dateTime: 210.0, amount: 1.00, userIdFrom: 1, userIdTo: 1}, o: `${tIdx++}` },
                { dstTable: DstTable.RAW,     t: {id: 1, dateTime: 210.0, amount: 1.00, userIdFrom: 2, userIdTo: 1}, o: `${tIdx++}` },
                { dstTable: DstTable.RAW,     t: {id: 3, dateTime: 210.0, amount: 1.00, userIdFrom: 0, userIdTo: 1}, o: `${tIdx++}` },
                { dstTable: DstTable.RAW,     t: {id: 3, dateTime: 210.0, amount: 1.00, userIdFrom: 1, userIdTo: 1}, o: `${tIdx++}` },
                { dstTable: DstTable.RAW,     t: {id: 3, dateTime: 210.0, amount: 1.00, userIdFrom: 2, userIdTo: 1}, o: `${tIdx++}` },
                { dstTable: DstTable.PRIMARY, t: {id: 4, dateTime: 210.0, amount: 1.00, userIdFrom: 0, userIdTo: 1}, o: `${tIdx++}` },
                { dstTable: DstTable.RAW,     t: {id: 4, dateTime: 210.0, amount: 1.00, userIdFrom: 1, userIdTo: 1}, o: `${tIdx++}` },
                { dstTable: DstTable.PRIMARY, t: {id: 5, dateTime: 210.0, amount: 1.00, userIdFrom: 0, userIdTo: 1}, o: `${tIdx++}` },
                { dstTable: DstTable.RAW,     t: {id: 5, dateTime: 210.0, amount: 1.00, userIdFrom: 1, userIdTo: 1}, o: `${tIdx++}` },
            ],
            [
                { dstTable: DstTable.RAW,       t: {id: 2, dateTime: 220, state: TResult.CONFIRMED}, o: `${rIdx++}` },
                { dstTable: DstTable.RAW,       t: {id: 3, dateTime: 220, state: TResult.CONFIRMED}, o: `${rIdx++}` },
                { dstTable: DstTable.RAW,       t: {id: 1, dateTime: 220, state: TResult.BLOCKED}, o: `${rIdx++}` },
                { dstTable: DstTable.PRIMARY,   t: {id: 4, dateTime: 220, state: TResult.CONFIRMED}, o: `${rIdx++}` },
                { dstTable: DstTable.PRIMARY,   t: {id: 5, dateTime: 220, state: TResult.BLOCKED}, o: `${rIdx++}` },
            ]
        ].map(b => b.map(t => {
            // Dud metadata records as completeness is not tested
            return { dstTable: t.dstTable, 
                t: { metadata: {}, payload: t.t } as InKafkaMessage,
                o: t.o };
        }));


        await sendTransactions(batches[0], `Sending transactions batch 0`);
        await sendTResults(batches[1], `Sending transaction results batch 1`);
        await checkValidTransactions([batches[0]], [batches[1]], 0, `Checking valid transactions after batch 0 and 1`);
        await checkValidTransactions([batches[0]], [batches[1]], 1, `Checking valid transactions after batch 0 and 1`);

        await sendTransactions(batches[2], `Sending transactions batch 2`);
        await sendTResults(batches[3], `Sending transaction results batch 3`);
        await checkValidTransactions([batches[0], batches[2]], [batches[1], batches[3]], 0, `Checking valid transactions after batch 2 and 3`);
        await checkValidTransactions([batches[0], batches[2]], [batches[1], batches[3]], 1, `Checking valid transactions after batch 2 and 3`);
        await checkValidTransactions([batches[0], batches[2]], [batches[1], batches[3]], 2, `Checking valid transactions after batch 2 and 3`);
    });
});