import util from 'util';
import { getEnv } from './common/utils.js';
import { describe, it } from 'mocha'
// addint as promised
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { logger } from './common/logger.js';
import { GenerationState, GenParameters, ProgressReportValidator, ProgressReport, UserCounters, Counters } from './common/generator_parameters.js';
import z, { ZodType } from 'zod';
import { gql } from 'graphql-request'
import * as fsp from 'fs/promises';
import { Deferred } from './common/utils.js';

import { InKafkaMessage, MetadataWrapperValidator, StatementParameters, StatementRequestResult, StatementType, Transaction, TransactionValidator } from './common/event_types.js';
import { processLineByLine } from './common/files.js';
import { getRandomValues } from 'crypto';
import { ProgressPrinter } from './common/utils.js';
import { getDatabaseStats, getGeneratorStats, getProgress, getStatement, postTransaction, startGen, stopGen } from './common/gqlDeclarations.js';
import { generateRecords, GQL_URL, GRAPH_QL_HOSTNAME, makeTestParams, SHARED_DIR, testStatements, waitForTransactionsToBeDeliveredToDB } from './test_helpers.js';
import { PostTransactionParams } from './common/generator_parameters.js';

chai.use(chaiAsPromised);
chai.config.includeStack = true;


const tp = getEnv('TESTER_PORT')
logger.info(`Using tester port ${tp}`)

describe('Kafka Consumer Tests', function () {
    this.timeout(1000000000); // set timeout for the tests
    it.only('', async () => {
        expect(true).to.be.true; // just to have a test
    });
    it.skip('Sanity check', async () => {
        expect(true).to.be.true; // just to have a test
        const def = new Deferred<void>();
        const fileName = SHARED_DIR + "/eben.txt";
        await fsp.unlink(fileName);
        const handle = await fsp.open(fileName, 'a')
        await Promise.all(Array.from({length: 100}).map((_,idx) => {
            handle!.write(`hello ${idx}\n`)
        }));
        await handle!.close();
        let lineCount = 0;
        // const inter = setInterval(() => {console.log(`Processed ${lineCount} lines so far...`);}, 5000);
        let stop = false;
        logger.log(`Processing starting`);
        await processLineByLine(fileName, async (line) => {
            lineCount++;
            // if (stop) return;
            // try {
            // await new Promise(r => setTimeout(r, 5000)); // simulate some processing
            expect(line).to.equal(`hello lineCount`);
            // } catch(e) {
            //     stop = true;
            //     def.reject(e);
            // }
        },10)
        logger.log(`Processed ${lineCount} lines`);
        // await def.promise;
    });
    it(`Simple functional test`, async () => {
        logger.info(`Starting functional test with `, GQL_URL);
        const runCount = 1000;
        // const params = await makeTestParams(1, 100000, runCount, () => Math.random());
        const params = await makeTestParams(1000, 1000000, runCount, () => Math.random());
        let statementTotalCount = 0;
        params.forEach(p => {
            statementTotalCount += p.userCount;
        })
        const progressTracker = new ProgressPrinter(statementTotalCount, (pc) => `transactions checked ${pc}%`)
        for (const param of params) {
            await generateRecords(param);
            await testStatements(progressTracker);
        }
    });
    it.skip(`Test statement offsets`, async () => {
        // post transactions with ids 1..1000 for user 1
        // send 200 transactions and see how windowing function returns values
        const dbInitialStats = await getDatabaseStats.fetchCall(GQL_URL)
        let lastTransactionId = 0
        let lastDate = 0
        // It is assumed that records are not reordered in time
        if (dbInitialStats.lastTransactionPosted) {
            const t = JSON.parse(dbInitialStats.lastTransactionPosted!)
            lastTransactionId = t["id"]
            lastDate = t["dateTime"]
        }
        if (dbInitialStats.lastTransactionRes) {
            const r = JSON.parse(dbInitialStats.lastTransactionRes!)
            lastTransactionId = Math.max(r["id"])
            lastDate = Math.max(r["dateTime"], lastDate)
        }
        const postedTransactions: PostTransactionParams[] = [];
        const toPost = 10;
        for (let i = 1; i <= toPost; i++) {
            const tx: PostTransactionParams = {
                id: lastTransactionId + i,
                date: lastDate + i,
                amount: 1,
                userFrom: 0,
                userTo: 1
            }
            await postTransaction.fetchCall(GQL_URL, tx);
            postedTransactions.push(tx);
        }
        let waitAttempts = 5;
        while (waitAttempts-- > 0) {
            const dbNewStats = await getDatabaseStats.fetchCall(GQL_URL)
            if (dbNewStats.transactionCount >= dbInitialStats.transactionCount + toPost) {
                break;
            }
            logger.log(`Waiting for transactions to be delivered to DB...`);
            await new Promise(r => setTimeout(r, 1000));
        }
        /*
            try all combinatitiosn of from/to, type, offset, count
            from - to: [0..999]
            offset: [0..to - from]
            count: max: to - from - offset
        */
       let counter = 0;
       const finishTracker = new Deferred<void>();
       for (let from = 1; from <= toPost; from++) {
            for (let to = from; to <= toPost; to++) {
                for (let offset = 0; offset <= (to - from); offset++) {
                    for (let count = 1; count <= (to - from - offset) + 1; count++) {
                        const params: StatementParameters = {
                            userId: 1,
                            fromm: lastDate + from,
                            too: lastDate + to,
                            type: StatementType.DS,
                            offset: offset,
                            count: count
                        }
                        counter++;
                        // Don't await - statement generator has dumb timer that bundles tasks
                        // If you wait - one task would be executed per interval
                        getStatement.fetchCall(GQL_URL, params)
                        .then(res => {
                            const idxStart = from + offset;
                            const idxEnd = idxStart + count - 1;
                            expect((res as StatementRequestResult).transactions.length).to.equal(idxEnd - idxStart + 1)
                            const printRec = () => {
                                return util.format(`Params`, params, "records", res.transactions,
                                    `expected`, postedTransactions.slice(idxStart - 1, idxEnd)
                                );
                            }
                            for (let i = idxStart; i <= idxEnd; i++) {
                                const rec = postedTransactions[i - 1];
                                const resRec = (res as StatementRequestResult).transactions[i - idxStart];
                                expect(resRec.id).to.equal(rec.id, `Wrong record id: ${printRec()}`);
                                expect(resRec.dateTime).to.equal(rec.date, `Wrong date: ${printRec()}`);
                                expect(resRec.userIdFrom).to.equal(rec.userFrom, `Wrong userIdFrom: ${printRec()}`);
                                expect(resRec.userIdTo).to.equal(rec.userTo, `Wrong userIdTo: ${printRec()}`);
                                expect(resRec.amount).to.equal(rec.amount, `Wrong amount: ${printRec()}`);
                            }
                            counter--;
                            if (counter === 0) {
                                finishTracker.resolve();
                            }
                        })
                        .catch(e => {
                            finishTracker.reject(e);
                        })
                    }
                }
            }
        }
        return finishTracker.promise;
    });
    it(`ui exposed functionality test`, async() => {
        //request n rows from an id and a regular expression
    })
})