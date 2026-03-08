import { UserConnection } from '../common/db/db_defines.js';
import { initializeDatabase } from '../common/db/init.js';
import { InKafkaMessage, StatementType, Transaction, TransactionResult, TransactionResultValidator, TransactionValidator, TResult } from '../common/event_types.js';
import { getEnv, last, OverflowingCounter} from '../common/utils.js';
import { DbSender, groupId, processConsumedBatch } from './sink.js';
import { logger } from '../common/logger.js';
import { parseQueryRes, RawTables, transactionResultsTable, TransactionResultStored, transactionsTable, TransactionStored } from '../common/db/tables.js';
import { SetUpTempTableProc, setUpTempTransactionResultsTable, setUpTempTransactionsTable } from '../common/db/procedures.js';
import { KAFKA_TOPICS_TRANSACTION_RESULTS, KAFKA_TOPICS_TRANSACTIONS } from '../common/kafka_client.js';

import { describe, it } from 'mocha'
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { exit } from 'process';
import { sinkUser } from '../common/db/auth.js';
chai.use(chaiAsPromised);
chai.config.includeStack = true;
chai.config.truncateThreshold = 10000

const topics = [KAFKA_TOPICS_TRANSACTION_RESULTS, KAFKA_TOPICS_TRANSACTIONS];
const [topic_transaction_res, topic_transactions] = topics;

const TEST_DB_NAME = "TestDB";
enum DstTable {
    RAW,
    PRIMARY
}
type Batch = { dstTable: DstTable, t: InKafkaMessage, o: string }[];

function getIgnoredRecords<T>(batch: Batch): T[] {
    // Get messages with duplicate ids, or with some other violating conditions,
    //  that were not recorded to primary table
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

function sendBatch(topic: string, batch: Batch, sender: DbSender) {
    const offset = last(batch)!.o;
    const messages = batch.map(b => JSON.stringify(b.t));
    return processConsumedBatch({topic, partition: 0, offset, groupId}, messages, sender);
}

async function testOffsets(topic: string, val: string, connection: UserConnection) {
    const offsets = await connection.getOffsets();
    chai.expect(offsets.getOffset(groupId, topic, 0)??'0', `expected ${val} from ${topic}`).to.equal(val);
}

async function sendTransactions(tBatch: Batch, msg: string) {
    const expectedIgnored = getIgnoredRecords<Transaction>(tBatch).sort((a, b) => a.id - b.id);
    await sendBatch(topic_transactions, tBatch, dbSender!);
    const ignored = (await dbSender!.connection.getRawData(expectedIgnored.length, RawTables.transactions))
    const parsed = ignored.map(i => TransactionValidator.parse(parseQueryRes(i, transactionsTable.columns)));
    compareObjecs(parsed, expectedIgnored, msg);
    await testOffsets(topic_transactions, last(tBatch)!.o, dbSender!.connection);
}
async function sendTResults(resBatch: Batch, msg: string) {
    const expectedIgnored = getIgnoredRecords<TransactionResult>(resBatch).sort((a, b) => a.id - b.id);
    await sendBatch(topic_transaction_res, resBatch, dbSender!);
    const ignored = ((await dbSender!.connection.getRawData(expectedIgnored.length, RawTables.transaction_results)));
    const parsed = ignored.map(i => TransactionResultValidator.parse(parseQueryRes(i, transactionResultsTable.columns)));
    compareObjecs(parsed, expectedIgnored, msg);
    await testOffsets(topic_transaction_res, last(resBatch)!.o, dbSender!.connection);
}
async function checkValidTransactions(tBatch: Batch[], resBatches: Batch[], user: number, msg: string) {
    const expectedReturned = getReturnedTransactions(tBatch, resBatches, user);
    const ts: Transaction[] = [];
    await dbSender!.connection.streamTransactions([{ userId: user, type: StatementType.FS }], async (userId: number, pidx: number, transaction: InKafkaMessage) => {
        ts.push(TransactionValidator.parse(transaction.payload));
    })
    compareObjecs(ts, expectedReturned, msg);
}
function compareObjecs<T>(actual: T[], expected: T[], message: string) {
    const a = actual
    const e = expected;
    chai.expect(a, message).to.deep.equal(e);
}
const user_sa = getEnv('DB_INITIALIZER_MSSQL_SA_USERNAME')
const passwd_sa = getEnv('DB_INITIALIZER_MSSQL_SA_PASSWORD')
const hostname = getEnv("MESSAGE_SINK_MSSQL_HOSTNAME");

const password = "$12345password"
const dbName = "messageSinkTestDB"

let dbSender: DbSender | undefined = undefined
describe('Kafka Consumer Tests', function () {
    let testIdx = 0;
    this.timeout(10000000); // Set timeout for the tests
    this.beforeEach(async () => {
        if (dbSender) {
            await dbSender.connection.pool.close();
        }
        testIdx++;
        const dbNameLocal = `${dbName}_${testIdx}`;
        await initializeDatabase(user_sa, passwd_sa, hostname, password, dbNameLocal);
        dbSender = new DbSender(await UserConnection.create(sinkUser, password, hostname, dbNameLocal));
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
    it.skip(`Test database row rotation`, async () => {
        const counter = new OverflowingCounter();
        let ROWCOUNT = 12000;

        while (true) {
            let msgs: InKafkaMessage[] = [];
            for (let i = 0; i < ROWCOUNT; i++) {
                counter.inc();
                msgs.push({ metadata: {},
                            payload: { id: counter.value, 
                                dateTime: 100.0 * counter.value, 
                                amount: 1.00, 
                                userIdFrom: 1, 
                                userIdTo: 2 } as Transaction });
            }
            type eb = SetUpTempTableProc<TransactionStored|TransactionResultStored>;
            const tempTable = setUpTempTransactionsTable as eb;
            const t1 = Date.now();
            if (Math.random() < 0.1) {
                logger.warn(`triggering conflict`)
                msgs.push({ metadata: {}, payload: { ...msgs[0].payload, id: msgs[0].payload.id} as Transaction });
            }
            await dbSender?.sendMessagesTransactionally(tempTable, msgs, 
                {topic: topic_transactions, partition: 0, offset: `${counter.value}`, groupId},
            Math.random() < 0.1); // 10% chance to trigger rollback
            const tempTableRes = setUpTempTransactionResultsTable as eb;
            await dbSender?.sendMessagesTransactionally(tempTableRes, msgs.map(n => {
                return { metadata: n.metadata, payload: { id: n.payload.id, dateTime: n.payload.dateTime, state: TResult.CONFIRMED } as TransactionResult }
            }), {topic: topic_transaction_res, partition: 0, offset: `${counter.value}`, groupId},
            Math.random() < 0.1); // 10% chance to trigger rollback
            const t2 = Date.now();
            logger.log(`insertion time`, t2 - t1);
        }
    })
});