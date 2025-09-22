import { MetadataWrapperValidator, StatementParameters, StatementType, Transaction, TransactionValidator } from "./common/event_types.js";
import { processLineByLine } from "./common/files.js";
import { Counters, GenerationState, GenParameters } from "./common/generator_parameters.js";
import { getGeneratorStats, getProgress, getStatement, startGen, stopGen } from "./common/gqlDeclarations.js";
import { logger } from "./common/logger.js";
import { getEnv, ProgressPrinter } from "./common/utils.js";
import chai, { expect } from 'chai';


import fs, { stat } from 'fs'

export const GRAPH_QL_HOSTNAME = getEnv("GRAPH_QL_HOSTNAME");
const GRAPH_QL_PORT = getEnv("GRAPH_QL_PORT");
export const GQL_URL = `http://${GRAPH_QL_HOSTNAME}:${GRAPH_QL_PORT}/graphql`
export const SHARED_DIR = getEnv('SHARED_DIR');

export function makeTestParams(maxUserCount: number, maxTransactionCount: number, runs: number, randomizer: () => number) : GenParameters[] {
    let dateFrom = 0;
    let minTransactionId = 0;
    const params: GenParameters[] = [];
    let maxUserId = 0;
    try {
        fs.readFileSync('last_user_id.txt', 'utf-8').split('\n').forEach(line => {
            const trimmed = line.trim();
            if (trimmed.length > 0) {
                const ress = trimmed.split(',')
                if (ress.length > 1) {
                    const uid = parseInt(ress[0]);
                    if (!isNaN(uid)) {
                        maxUserId = Math.max(maxUserId, uid);
                    }
                    const tid = parseInt(ress[1]);
                    if (!isNaN(tid)) {
                        minTransactionId = Math.max(minTransactionId, tid);
                    }
                }
            }
        });
    } catch (e) {
        // ignore
    }
    maxUserId = Math.max(maxUserId, 1);
    console.log(`Starting from max user id ${maxUserId}`);
    for (let i = 0; i < runs; i++) {
        const userCount = Math.min(maxUserCount, Math.floor(1 + randomizer() * maxUserCount));
        const dateRange = 1 + Math.floor(randomizer() * 1000000);
        const transactionCount = Math.floor(Math.max(1, randomizer() * maxTransactionCount));
        const minUserId = maxUserId + Math.floor(Math.max(randomizer() * (maxUserCount - userCount), 0));
        params.push({
            userCount,
            dateFrom,
            dateTo: dateFrom + dateRange,
            transactionCount,
            maxDelayMs: Math.floor(randomizer() * 1000),
            minUserId,
            minTransactionId
        });
        maxUserId = Math.max(maxUserId, minUserId + userCount);
        dateFrom += dateRange + 1;
        minTransactionId += transactionCount;
    }
    fs.writeFileSync('last_user_id.txt', [maxUserId, minTransactionId].join(','));
    return params
}
export async function generateRecords(params: GenParameters) {
    await stopGen.fetchCall(GQL_URL); // stop any previous generation
    await startGen.fetchCall(GQL_URL, params);
    // Wait for generation to stop so all records are posted to Kafka
    let interval = 100;
    const startTime = Date.now();
    let runNum = 0;
    while (true) {
        runNum++;
        await new Promise(resolve => setTimeout(resolve, interval));
        const progress = await getProgress.fetchCall(GQL_URL);
        if (progress.isRunning === GenerationState.STOPPED) {
            console.log("Generation stopped.");
            break;
        }
        const now = Date.now();
        const elapsed = Math.max((now - startTime), 1)
        const completionRate = elapsed / Math.max(1, progress.percentComplete);
        const timeToFinish = completionRate * (100 - progress.percentComplete);
        interval = Math.min(2000, Math.max(100, timeToFinish));
        console.log(`Progress: ${JSON.stringify(progress)} at ${runNum} delay ${now - startTime}, next in ${interval}ms`);
    }
}
type WaitStats = {
     lastMsgTime: number,
     totalCount: number,
     fetchedCount: number,
     userCount: number
}
export async function waitForTransactionsToBeDeliveredToDB(expectedCount: number, 
    params: StatementParameters, ws: WaitStats): Promise<void> {
    let retries = 10;
    let lastCount = 0;
    ws.totalCount += expectedCount;
    ws.userCount++;
    while (retries-- > 0) {
        // TODO: try paginated big requests
        const res = await testRequestedStatement(params, true)
        ws.fetchedCount += (res.tCount - lastCount);
        if (res.tCount > lastCount) {
            // got some new transactions, reset retries
            retries = 10;
        }
        lastCount = res.tCount;
        if (res.tCount >= expectedCount) break;
        const newNow = Date.now();
        if (newNow - ws.lastMsgTime > 2000) {
            ws.lastMsgTime = newNow;
            logger.log(`Waiting for transactions to be delivered to DB: ${ws.fetchedCount}/${ws.totalCount} for ${ws.userCount} users`);
        }
        await new Promise(r => setTimeout(r, 1000));
    }
    ws.fetchedCount -= lastCount;
    ws.userCount--;
    ws.totalCount -= expectedCount;
    if (retries <= 0) {
        throw `Timeout waiting for transactions to be delivered to DB, only ${lastCount} of ${expectedCount} received for user ${params.userId}`;
    }
}

type TestValues = { tCount: number, tSum: number, file: string };
export async function testRequestedStatement(params:StatementParameters, rmServed: boolean = true): Promise<TestValues> {
    const res = await getStatement.fetchCall(GQL_URL, params)
    const idSet = new Set<number>();
    let lastDate = params.fromm??0;
    let amountSum = 0;
    const statementFileName = SHARED_DIR + "/" + res
    function tInfo(ta: Transaction, p? : StatementParameters) {
        return statementFileName + ": " + JSON.stringify(ta) + (p ? ` for params ${JSON.stringify(p)}` : '');
    }
    await processLineByLine(statementFileName, async (line) => {
        const t: Transaction = TransactionValidator.parse(MetadataWrapperValidator.parse(JSON.parse(line)).payload);
        expect(idSet.has(t.id)).to.be.eq(false, `duplicate transaction id ${tInfo(t,params)}`);
        expect(t.userIdFrom == params.userId || t.userIdTo == params.userId).to.be.eq(true, `T with wrong users: ${tInfo(t,params)}`);
        expect(t.dateTime).to.be.greaterThanOrEqual(lastDate, `T date order violated: ${tInfo(t,params)} after ${lastDate}`);
        if (params.fromm !== undefined) {
            expect(t.dateTime).to.be.at.least(params.fromm, `T date before min date in ${tInfo(t,params)}`);
        }
        if (params.too !== undefined) {
            expect(t.dateTime).to.be.at.most(params.too, `T date past max date in ${tInfo(t,params)}`);
        }
        lastDate = t.dateTime;
        amountSum += t.amount;
        idSet.add(t.id);
    });
    if (rmServed) {
        fs.unlink(statementFileName, (_) => {});
    }
    return { tCount: idSet.size, tSum: Math.floor(amountSum), file: statementFileName };
}
export async function testStatements(progressTracker: ProgressPrinter) {
    const statFile = SHARED_DIR + '/' + (await getGeneratorStats.fetchCall(GQL_URL));
    const ws: WaitStats = { lastMsgTime: 0, totalCount: 0, fetchedCount: 0, userCount: 0 };
    await processLineByLine(statFile, async (line) => {
        const counter = Counters.deserialise(line)
        expect(counter.minDate).to.not.be.undefined;
        expect(counter.maxDate).to.not.be.undefined;
        // console.log(`Processing line: ${JSON.stringify(counter)}`);
        const statementParams = { userId: counter.userId, type: StatementType.FS }
        await waitForTransactionsToBeDeliveredToDB(counter.transactionCount, statementParams, ws);
        // Make three date ranges and request statements for all of them to check
        // that transaction ids there are of proper dates and no dumplicates are contained.
        expect(counter.maxDate! - counter.minDate!).to.be.greaterThanOrEqual(2, `Transaction range is not big enough for  ${JSON.stringify(counter)}`);
        const ranges: Array<[number, number]> = [];
        if (counter.transactionCount < 3) {
            ranges.push([counter.minDate!, counter.maxDate!]);
        } else {
            const getRange = (min: number, max: number): [number,number] => [min, min + Math.round(Math.random() * (max - min))]
            const leftRange = getRange(counter.minDate!, counter.maxDate! - 2);
            const midRange = getRange(leftRange[1] + 1, counter.maxDate! - 1);
            const rightRange = [midRange[1] + 1, counter.maxDate!] as [number, number];
            ranges.push(leftRange);
            ranges.push(midRange);
            ranges.push(rightRange);
        }

        const res = await Promise.all(ranges.map(r => {
            return testRequestedStatement({ userId: counter.userId, type: StatementType.FS, fromm: r[0], too: r[1] }, true)
        }))
        const totalRes = res.reduce<TestValues>((acc, cur) => {
            acc.tCount += cur.tCount;
            acc.tSum += cur.tSum;
            return acc;
        }, { tCount: 0, tSum: 0, file: '' });
        progressTracker.writeProgress();
        expect(Math.floor(totalRes.tSum)).to.equal(counter.amountSum, `Wrong total amount for user ${counter.userId} from ${JSON.stringify(res)}`);
        expect(totalRes.tCount).to.equal(counter.transactionCount, `Wrong transaction count for user ${counter.userId} from ${JSON.stringify(res)}`);
    }, 100);
}