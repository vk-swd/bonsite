import utils from "util";
import { MetadataWrapperValidator, StatementParameters, StatementType, Transaction, TransactionResultValidator, TransactionValidator } from "../common/event_types.js";
import { processLineByLine } from "../common/files.js";
import { Counters, GenerationState, GenParameters } from "../common/generator_parameters.js";
import { getDatabaseStats, getGeneratorStats, getProgress, getStatement, startGen, stopGen } from "../common/gqlDeclarations.js";
import { logger } from "../common/logger.js";
import { getEnv, ProgressPrinter, sleep } from "../common/utils.js";
import chai, { expect } from 'chai';
import z from "zod";


import fs, { stat } from 'fs'
import fsp from 'fs/promises'


export const GQL_URL = `http://${getEnv("TESTER_GQL_HOSTNAME")}:${getEnv("TESTER_GQL_PORT")}/graphql`
export const SHARED_DIR = getEnv('SHARED_DIR');

function getLastRecordDate(res: number, record: string | undefined | null, validator: typeof TransactionValidator | typeof TransactionResultValidator): number {
    if (record && record.length > 2) {
        const lastT = validator.parse(JSON.parse(record, (key, value) => {
            if (key === 'dateTime' && typeof value === 'string') {
                return new Date(value).getTime();
            }
            return value;
        }));
        // Add 100ms to make sure new transactions are later than the last one in DB
        // to avoid problems with same millisecond timestamps
        res = Math.max(res, new Date(lastT.dateTime).getTime() + 100);
    }
    return res;
}
export async function makeTestParams(maxUserCount: number, maxTransactionCount: number, 
    runs: number, randomizer: () => number) : Promise<GenParameters[]> {
    const params: GenParameters[] = [];
    const dbInitialStats = await getDatabaseStats.fetchCall(GQL_URL)
    let dateFrom = getLastRecordDate(0, dbInitialStats.lastTransactionPosted, TransactionValidator);
    dateFrom = getLastRecordDate(dateFrom, dbInitialStats.lastTransactionRes, TransactionResultValidator);
    let minUserId = Math.max(dbInitialStats.maxUserId, 1) + 1;
    let minTransactionId = Math.max(dbInitialStats.maxTransactionId, dbInitialStats.maxTransactionResId) + 1
    
    for (let i = 0; i < runs; i++) {
        const userCount = Math.min(maxUserCount, Math.floor(1 + randomizer() * maxUserCount));
        const dateRange = 1 + Math.floor(randomizer() * 1000000);
        const transactionCount = Math.floor(Math.max(1, randomizer() * maxTransactionCount));
        params.push({
            userCount,
            dateFrom,
            dateTo: dateFrom + dateRange,
            transactionCount,
            maxDelayMs: Math.floor(randomizer() * 1000),
            minUserId,
            minTransactionId
        });
        minUserId = Math.max(minUserId, minUserId + userCount) + 1;
        dateFrom += dateRange + 100;
        minTransactionId += transactionCount;
    }
    // console.log(`Starting from min user id ${minUserId} from ${dateFrom}`, dbInitialStats, params);
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
     userCount: number,
     usersChecked: number
}
export function waitForTransactionsToBeDeliveredToDB(tester: StatementTestState, 
    ws: WaitStats, retries: number, start = true): Promise<void> {
    if (retries <= 0) {
        throw utils.format(`Waiting for db failed for `, tester.params, tester.idSet.size, "/", tester.counter.transactionCount);
    }
    if (start) {
        ws.totalCount += tester.counter.transactionCount;
        ws.userCount++;
    }

    // getDatabaseStats.fetchCall(GQL_URL).then((dbStats) => {
    //     if (dbStats.maxTransactionId) {
    //         if (dbStats.maxTransactionId >= tester.counter.maxTransactionId) {
    //             // probably all transactions are in DB, check how many we got
    //             return;
    //         }
    //     }

    return testRequestedStatement(tester, true)
    .then(() => {
        const res = tester.result();
        ws.fetchedCount += (res.tCount - tester.lastCount);
        if (res.tCount > tester.lastCount) {
            // got some new transactions, reset retries
            retries += 2;
        }
        tester.lastCount = res.tCount;
        if (res.tCount >= tester.counter.transactionCount) {
            return;
        }
        const newNow = Date.now();
        if (newNow - ws.lastMsgTime > 2000) {
            ws.lastMsgTime = newNow;
            logger.log(`Waiting for transactions to be delivered to DB: ${ws.fetchedCount}/${ws.totalCount} for ${ws.usersChecked}/${ws.userCount} users`);
        }
        tester.reset();
        return new Promise<void>(r => setTimeout(() => {
            waitForTransactionsToBeDeliveredToDB(tester, ws, retries - 1, false).finally(() => r());
        }, 3000));
    }).finally(() => {
        if (start) {
            ws.fetchedCount -= tester.lastCount;
            ws.userCount--;
            ws.totalCount -= tester.counter.transactionCount;
        }
    })
}
function tInfo(ta: Transaction, p? : StatementParameters, statementFileName: string = ""): string {
    return statementFileName + ": " + JSON.stringify(ta) + (p ? ` for params ${JSON.stringify(p)}` : '');
}
class StatementTestState {
    idSet = new Set<number>();
    lastDate: number;
    lastCount = 0;
    amountSum = 0;
    constructor(public params:StatementParameters, public counter: Counters) {
        this.lastDate = params.fromm??0;
    }
    addTransaction(t: Transaction) {
        expect(this.idSet.has(t.id)).to.be.eq(false, `duplicate transaction id ${tInfo(t,this.params)}`);
        expect(t.userIdFrom == this.params.userId || t.userIdTo == this.params.userId).to.be.eq(true, `T with wrong users: ${tInfo(t,this.params)}`);
        expect(t.dateTime).to.be.greaterThanOrEqual(this.lastDate, `T date order violated: ${tInfo(t,this.params)} after ${this.lastDate}`);
        if (this.params.fromm !== undefined) {
            expect(t.dateTime).to.be.at.least(this.params.fromm, `T date before min date in ${tInfo(t,this.params)}`);
        }
        if (this.params.too !== undefined) {
            expect(t.dateTime).to.be.at.most(this.params.too, `T date past max date in ${tInfo(t,this.params)}`);
        }
        this.lastDate = t.dateTime;
        this.amountSum += t.amount;
        this.idSet.add(t.id);
    }
    result(file?: string): TestValues {
        return { tCount: this.idSet.size, tSum: this.amountSum, file:file??"" };
    }
    reset() {
        this.lastCount = this.idSet.size;
        this.idSet.clear();
        this.lastDate = this.params.fromm??0;
        this.amountSum = 0;
    }
}
type TestValues = { tCount: number, tSum: number, file: string };
export async function testRequestedStatement(tester: StatementTestState, rmServed: boolean = true): Promise<void> {
    return getStatement.fetchCall(GQL_URL, tester.params)
    .then((res: any) => {
        // logger.log(`stat`, res)
        if (res.transactions.length) {
            for (const t of res.transactions) {
                tester.addTransaction(t);
            }
        } else if (res.filePath.length > 0) {
            const statementFileName = SHARED_DIR + "/" + res.filePath;
            return processLineByLine(statementFileName, async (line) => {
                const t: Transaction = TransactionValidator.parse(MetadataWrapperValidator.parse(JSON.parse(line)).payload);
                tester.addTransaction(t);
            }).then(() => {})
            .finally(() => {
                if (rmServed) {
                    fs.unlink(statementFileName, (err) => {
                        if (err) {
                            console.error(`Error removing served statement file ${statementFileName}: ${err}`);
                        }
                    });
                }
            })
        }
    }).catch(e => {
        throw new Error(utils.format(`Error fetching statement for params `, tester.params, e));
    });
}
export async function testStatements(progressTracker: ProgressPrinter) {
    const statFile = SHARED_DIR + '/' + (await getGeneratorStats.fetchCall(GQL_URL));
    let maxId = 0;
    let done = false;
    await processLineByLine(statFile, async (line) => {
        if (done) {
            return;
        }
        done = true;
        maxId = Number.parseInt(line);
    }, 1, 1);
    logger.log(`Max generated transaction id ${maxId}`);
    let lastId = 0;
    let retries = 20;
    while (retries > 0) {
        const dbInitialStats = await getDatabaseStats.fetchCall(GQL_URL)
        if (dbInitialStats.maxTransactionId >= maxId) {
            break;
        }
        logger.log(`Waiting for all generated transactions to be delivered to DB: ${dbInitialStats.maxTransactionId}/${maxId}`);
        await sleep(3000);
        if (lastId == dbInitialStats.maxTransactionId) {
            retries--;
        } else {
            lastId = dbInitialStats.maxTransactionId;
            retries = 20;
        }
    }


    let idx = 0;
    const ws: WaitStats = { lastMsgTime: 0, totalCount: 0, fetchedCount: 0, userCount: 0, usersChecked: 0 };
    return processLineByLine(statFile, async (line) => {
            if (idx == 0) {
                idx++;
                return; // skip max id line
            }
            const counter = Counters.deserialise(line)
            expect(counter.minDate).to.not.be.undefined;
            expect(counter.maxDate).to.not.be.undefined;
            // console.log(`Processing line: ${JSON.stringify(counter)}`);
            const statementParams: StatementParameters = { 
                userId: counter.userId, 
                type: StatementType.FS 
            };
            if (counter.transactionCount < 100) {
                statementParams.type = StatementType.DS;
            }
            const tester = new StatementTestState(statementParams, counter);
            return testRequestedStatement(tester, true).then(_=> tester)
        //     return waitForTransactionsToBeDeliveredToDB(tester, ws, 10).then(_=> tester)
        .then((tester) => {

            // Test how date ranges are delivered by 
            // 1. Splitting all transactions in 3 chunks
            // 2. Requesting each chunk separately
            // 3. Combining them and checking against total result
            // Ideally should have use checksums but maybe will do it later.
            const ranges: Array<StatementTestState> = [];
            if (counter.transactionCount < 3) {
                ranges.push(new StatementTestState(
                    {...tester.params, fromm: counter.minDate!, too: counter.maxDate!}, tester.counter));
            } else {
                const getRange = (min: number, max: number): [number,number] => [min, min + Math.round(Math.random() * (max - min))]
                const leftRange = getRange(counter.minDate!, counter.maxDate! - 2);
                const midRange = getRange(leftRange[1] + 1, counter.maxDate! - 1);
                const rightRange = [midRange[1] + 1, counter.maxDate!] as [number, number];
                ranges.push(new StatementTestState({...tester.params, fromm: leftRange[0], too: leftRange[1]}, tester.counter));
                ranges.push(new StatementTestState({...tester.params, fromm: midRange[0], too: midRange[1]}, tester.counter));
                ranges.push(new StatementTestState({...tester.params, fromm: rightRange[0], too: rightRange[1]}, tester.counter));
            }
            return Promise.all(ranges.map(r => {
                return testRequestedStatement(r, true)
            }))
            .then(_ => ranges)
        })
        .then((res) => {
            const totalRes = res.reduce<TestValues>((acc, cur) => {
                acc.tCount += cur.idSet.size;
                acc.tSum += cur.amountSum;
                return acc;
            }, { tCount: 0, tSum: 0, file: '' });
            progressTracker.writeProgress();
            expect(Math.floor(totalRes.tSum)).to.equal(counter.amountSum, `Wrong total amount for user ${counter.userId} from ${JSON.stringify(res)}`);
            expect(totalRes.tCount).to.equal(counter.transactionCount, `Wrong transaction count for user ${counter.userId} from ${JSON.stringify(res)}`);
            ws.usersChecked++;
        });
    }, 200);
}