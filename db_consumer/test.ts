import { createSchema, UserConnection } from './common/db_defines.js';
import { Transaction, TransactionResult } from './common/event_types.js';
import { getEnv, last } from './common/utils.js';
import { processConsumedBatch } from './main.js';
import { describe, it } from 'mocha'
// addint as promised
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { exit } from 'process';
chai.use(chaiAsPromised);

const groupId = getEnv("KAFKA_GROUP_ID");
const topics = [getEnv("KAFKA_TOPICS_TRANSACTION_RESULTS"), getEnv("KAFKA_TOPICS_TRANSACTIONS")];
const [topic_transaction_res, topic_transactions] = topics;
console.log(`Using groupId: ${groupId}, topics: ${topics}`);


type Batch = { t: Transaction | TransactionResult, o: string }[];
function sendBatch(topic: string, batch: Batch, db_connection: UserConnection) {
    const offset = last(batch)!.o;
    const messages = batch.map(b => JSON.stringify(b.t));
    return processConsumedBatch(topic, 0, messages, offset, db_connection);
}

const partitionsPerTOpic = [
    { topic: topic_transaction_res, partitions: [0] },
    { topic: topic_transactions, partitions: [0] }
];

async function testOffsets(t: string, r: string, connection: UserConnection) {
    const offsets = await connection.getOffsets(groupId, partitionsPerTOpic);
    chai.expect(offsets.getOffset(topic_transactions, 0)??'0', `expected ${t} from ${topic_transactions}`).to.equal(t);
    chai.expect(offsets.getOffset(topic_transaction_res, 0)??'0', `expected ${r} from ${topic_transaction_res}`).to.equal(r);
}



describe('Kafka Consumer Tests', function () {
    this.timeout(10000); // Set timeout for the tests
    let db_connection: UserConnection | undefined = undefined
    function compare(o1: string, o2:string){ 
        it('compare offsets', async () => {
            await testOffsets(o1, o2, db_connection!);
        })
    }

    this.beforeEach(async () => {
        await createSchema();
        try {
            db_connection = await UserConnection.create();
        } catch (e) {
            console.error(`Failed to create database connection: ${e}`);
            exit(1);
        }
    });
    this.afterEach(async () => {
        if (db_connection) {
            console.log(`Closing database connection`);
            await db_connection.close();
            console.log(`Database connection closed`);
            db_connection = undefined;
        }
    });     
    it(`test simple conflict detection`, async () => {
        let tIdx = 1;
        const batches: Batch[] = [
            [
                { t: {id: 1, userIdFrom: 0, userIdTo: 1, amount: 1, dateTime: 0}, o: `${tIdx++}` },
                { t: {id: 1, userIdFrom: 1, userIdTo: 1, amount: 1, dateTime: 0}, o: `${tIdx++}` },
                { t: {id: 2, userIdFrom: 0, userIdTo: 1, amount: 1, dateTime: 0}, o: `${tIdx++}` },
                { t: {id: 3, userIdFrom: 0, userIdTo: 1, amount: 1, dateTime: 0}, o: `${tIdx++}` },
                { t: {id: 3, userIdFrom: 1, userIdTo: 1, amount: 1, dateTime: 0}, o: `${tIdx++}` },
            ],
            [
                { t: {id: 1, userIdFrom: 0, userIdTo: 1, amount: 1, dateTime: 0}, o: `${tIdx++}` },
                { t: {id: 1, userIdFrom: 1, userIdTo: 1, amount: 1, dateTime: 0}, o: `${tIdx++}` },
                { t: {id: 1, userIdFrom: 2, userIdTo: 1, amount: 1, dateTime: 0}, o: `${tIdx++}` },
                { t: {id: 3, userIdFrom: 0, userIdTo: 1, amount: 1, dateTime: 0}, o: `${tIdx++}` },
                { t: {id: 3, userIdFrom: 1, userIdTo: 1, amount: 1, dateTime: 0}, o: `${tIdx++}` },
                { t: {id: 3, userIdFrom: 2, userIdTo: 1, amount: 1, dateTime: 0}, o: `${tIdx++}` },
                { t: {id: 4, userIdFrom: 0, userIdTo: 1, amount: 1, dateTime: 0}, o: `${tIdx++}` },
                { t: {id: 4, userIdFrom: 1, userIdTo: 1, amount: 1, dateTime: 0}, o: `${tIdx++}` },
                { t: {id: 5, userIdFrom: 0, userIdTo: 1, amount: 1, dateTime: 0}, o: `${tIdx++}` },
                { t: {id: 5, userIdFrom: 1, userIdTo: 1, amount: 1, dateTime: 0}, o: `${tIdx++}` },
            ],
        ]
        try {
        await sendBatch(topic_transactions, batches[0], db_connection!);
        // await expect(db_connection!.getTransactions(), `couldnt get transaction`).to.eventually.eq([
        //     { id: 1, userIdFrom: 0, userIdTo: 1, amount: 1, dateTime: 0 },
        //     { id: 2, userIdFrom: 0, userIdTo: 1, amount: 1, dateTime: 1 },
        //     { id: 3, userIdFrom: 0, userIdTo: 1, amount: 1, dateTime: 2 },
        // ]);
        // expect((await db_connection!.getRawData()).map(d => d.data)).to.eventually.eq([
        //     '{id: 1, userIdFrom: 1, userIdTo: 1, amount: 1, dateTime: 1}',
        //     '{id: 2, userIdFrom: 1, userIdTo: 1, amount: 1, dateTime: 1}',
        //     '{id: 3, userIdFrom: 1, userIdTo: 1, amount: 1, dateTime: 2}'
        // ]);
        await sendBatch(topic_transactions, batches[1], db_connection!);
        const rex: Transaction[] = [
        { id: 1, userIdFrom: 0, userIdTo: 1, dateTime: 0, amount: 1 },
        { id: 2, userIdFrom: 0, userIdTo: 1, dateTime: 0, amount: 1 },
        { id: 3, userIdFrom: 0, userIdTo: 1, dateTime: 0, amount: 1 },
        { id: 4, userIdFrom: 0, userIdTo: 1, dateTime: 0, amount: 1 },
        { id: 5, userIdFrom: 0, userIdTo: 1, dateTime: 0, amount: 1 }];
        const res = await db_connection!.getTransactions();
        res.forEach((r,idx) => {
            console.log(`compare ${rex[idx]==r} ${JSON.stringify(rex[idx])} vs ${JSON.stringify(r)}`)
        })
        expect(JSON.stringify(res), `comparing ${JSON.stringify(res)}`).to.eq(JSON.stringify(rex));
        // expect((await db_connection!.getRawData()).map(d => d.data)).to.eventually.eq([
        //     '{id: 1, userIdFrom: 1, userIdTo: 1, amount: 1, dateTime: 1}',
        //     '{id: 2, userIdFrom: 1, userIdTo: 1, amount: 1, dateTime: 1}',
        //     '{id: 3, userIdFrom: 1, userIdTo: 1, amount: 1, dateTime: 2}',
        //     '{id: 1, userIdFrom: 1, userIdTo: 1, amount: 1, dateTime: 1}',
        //     '{id: 1, userIdFrom: 2, userIdTo: 1, amount: 1, dateTime: 1}',
        //     '{id: 3, userIdFrom: 1, userIdTo: 1, amount: 1, dateTime: 2}',
        //     '{id: 3, userIdFrom: 2, userIdTo: 1, amount: 1, dateTime: 2}',
        //     '{id: 4, userIdFrom: 1, userIdTo: 1, amount: 1, dateTime: 2}',
        //     '{id: 5, userIdFrom: 1, userIdTo: 1, amount: 1, dateTime: 2}',
        // ]);
        } catch (e) {
            console.error(`Error during conflict detection test: ${e}`);
            throw e;
        }
    });

    it('should process transactions and results', async () => {
        await compare('0', '0');
        let tIdx = 1;
        let tIdxR = 1;
        const batches: Batch[] = [
            [
                { t: {id: 1, userIdFrom: 0, userIdTo: 1, amount: 1, dateTime: 0}, o: `${tIdx++}` },
                { t: {id: 2, userIdFrom: 0, userIdTo: 1, amount: 1, dateTime: 1}, o: `${tIdx++}` },
                { t: {id: 3, userIdFrom: 0, userIdTo: 1, amount: 1, dateTime: 2}, o: `${tIdx++}` },
                { t: {id: 4, userIdFrom: 0, userIdTo: 1, amount: 1, dateTime: 3}, o: `${tIdx++}` },
                { t: {id: 5, userIdFrom: 0, userIdTo: 1, amount: 1, dateTime: 4}, o: `${tIdx++}` },
            ],
            [
                { t: {id: 1, userIdFrom: 0, userIdTo: 1, amount: 1, dateTime: 0}, o: `${tIdx++}` },
                { t: {id: 2, userIdFrom: 0, userIdTo: 1, amount: 1, dateTime: 1}, o: `${tIdx++}` },
                { t: {id: 3, userIdFrom: 0, userIdTo: 1, amount: 1, dateTime: 2}, o: `${tIdx++}` },
                { t: {id: 4, userIdFrom: 0, userIdTo: 1, amount: 1, dateTime: 3}, o: `${tIdx++}` },
                { t: {id: 5, userIdFrom: 0, userIdTo: 1, amount: 1, dateTime: 4}, o: `${tIdx++}` },
            ],
            [    
                { t: {transactionID: 1, dateTime: 10, state: 1}, o: `${tIdxR++}` },
                { t: {transactionID: 2, dateTime: 11, state: 2}, o: `${tIdxR++}` },
                { t: {transactionID: 3, dateTime: 12, state: 3}, o: `${tIdxR++}` },
                { t: {transactionID: 4, dateTime: 13, state: 4}, o: `${tIdxR++}` },
                { t: {transactionID: 5, dateTime: 14, state: 0}, o: `${tIdxR++}` },
            ],
            [    
                { t: {transactionID: 1, dateTime: 10, state: 1}, o: `${tIdxR++}` },
                { t: {transactionID: 2, dateTime: 11, state: 2}, o: `${tIdxR++}` },
                { t: {transactionID: 3, dateTime: 12, state: 3}, o: `${tIdxR++}` },
                { t: {transactionID: 4, dateTime: 13, state: 4}, o: `${tIdxR++}` },
                { t: {transactionID: 5, dateTime: 14, state: 0}, o: `${tIdxR++}` },
            ]
        ]
        await sendBatch(topic_transactions, batches[0], db_connection!);
        await compare('5', '0')
        await sendBatch(topic_transactions, batches[1], db_connection!);
        await compare('10', '0');
        // await sendBatch(topic_transaction_res, batches[2], db_connection);
        // await compare('5', '5');
        /*  Normal
            Duplicates
            Unordered
            Conflicts
            Malformed
            Lost connection - check offset
        */
    });
    this.afterAll(async () => {
        exit(0); // Exit after tests
    })
});
