import { getEnv, processLineByLine } from './common/utils.js';
import { describe, it } from 'mocha'
// addint as promised
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { logger } from './common/logger.js';
import { GenerationState, GenParameters, ProgressReportValidator, ProgressReport, RequestResult, UserCounters, Counters } from './common/generator_parameters.js';
import { RequestResultValidator, RequestStatus } from './common/generator_parameters.js';
import z, { ZodType } from 'zod';
import { gql } from 'graphql-request'
import fs, { stat } from 'fs'
import { InKafkaMessage, MetadataWrapperValidator, StatementParameters, StatementType, TransactionValidator } from './common/event_types.js';
import { Transaction } from 'mssql';

chai.use(chaiAsPromised);
chai.config.includeStack = true;


const GRAPH_QL_HOSTNAME = getEnv("GRAPH_QL_HOSTNAME");
const GRAPH_QL_PORT = getEnv("GRAPH_QL_PORT");
const SHARED_DIR = getEnv('SHARED_DIR');

describe('Kafka Consumer Tests', function () {
    this.timeout(1000000); // set timeout for the tests
    const reqResultFields = `{${Object.keys(RequestResultValidator.shape).map(key => `${key}`).join("\n")}}`;
    const startQuery = (params: GenParameters) => gql`{ startGen(params:${JSON.stringify(params).replace(/"/g, "")}) ${reqResultFields}}`; 
    const stopQuery = `{ stopGen ${reqResultFields} }`;
    const progressQuery = `{ getProgress {
        ... on ProgressReport {
        ${Object.keys(ProgressReportValidator.shape).map(key => `${key}`).join("\n")}
        }
        ... on Result ${reqResultFields}
      }}`
    const statementQuery = (params: StatementParameters) => `{ getStatement(params:${JSON.stringify(params).replace(/"/g, "")}) ${reqResultFields}}`;
    const request1 = async <T>(method: "POST" | "GET", query: string, field: string, validator: ZodType<T>) : Promise<T> => {
        let rewRes
        let jsonRes
        const doc = gql`${query}`
        try {
            // jsonRes = await request(`http://${GRAPH_QL_HOSTNAME}:${GRAPH_QL_PORT}/graphql`, doc)
            rewRes = await fetch(`http://${GRAPH_QL_HOSTNAME}:${GRAPH_QL_PORT}/graphql`, {
                method,
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                },
                body: JSON.stringify({ query }),
            })
            jsonRes = (await rewRes.json());
            return validator.parse((jsonRes.data)[field]);
        } catch (e) {
            logger.error(`Error in request ${doc}. Raw res: ${JSON.stringify(rewRes)} - ${JSON.stringify(jsonRes)}. Error: ${e}`);
            throw e;
        }
    }
    const stopGen = async () => await request1("POST", stopQuery, "stopGen", RequestResultValidator);
    const startGen = async (params: GenParameters) => await request1("POST", startQuery(params), "startGen", RequestResultValidator);
    const getProgress = async () => await request1("POST", progressQuery, "getProgress", ProgressReportValidator);
    const getStat = async () => await request1<RequestResult>("POST", `{ getGeneratorStats ${reqResultFields} }`, "getGeneratorStats", RequestResultValidator);
    const getStatement = async (params: StatementParameters) => await request1("POST", statementQuery(params), "getStatement", RequestResultValidator);
    it('', async () => {
        expect(true).to.be.true; // just to have a test
    });
    function makeTestParams(maxUserCount: number, maxTransactionCount: number, runs: number, randomizer: () => number) : GenParameters[] {
        let dateFrom = 0;
        let minTransactionId = 0;
        const params: GenParameters[] = [];
        for (let i = 0; i < runs; i++) {
            const userCount = Math.min(maxUserCount, Math.floor(1 + randomizer() * maxUserCount));
            const dateRange = 1 + Math.floor(randomizer() * 1000000);
            const transactionCount = Math.floor(Math.max(1, randomizer() * maxTransactionCount));
            const minUserId = Math.floor(Math.max(randomizer() * (maxUserCount - userCount), 0));
            params.push({
                userCount,
                dateFrom,
                dateTo: dateFrom + dateRange,
                transactionCount,
                maxDelayMs: Math.floor(randomizer() * 1000),
                minUserId,
                minTransactionId
            });
            dateFrom += dateRange + 1;
            minTransactionId += transactionCount;
        }
        return params
    }
    async function generateRecords(params: GenParameters) {
        await stopGen(); // stop any previous generation
        const results = await startGen(params) as RequestResult;
        expect(results.status, `bad status in ${JSON.stringify(results)}`).to.equal(RequestStatus.OK);
        // Wait for generation to stop so all records are posted to Kafka
        let interval = 100;
        const startTime = Date.now();
        let runNum = 0;
        while (true) {
            runNum++;
            await new Promise(resolve => setTimeout(resolve, interval));
            const progress = await getProgress() as ProgressReport;
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
    async function waitForTransactionsToBeDeliveredToDB(expectedCount: number, params: StatementParameters): Promise<InKafkaMessage[]> {
        const transactions: InKafkaMessage[] = [];
        let retries = 10;
        while (retries-- > 0) {
            // console.log(`Waiting for transactions to be delivered to DB, attempt ${10 - retries}`);
            const res = await getStatement(params)
            // console.log(`Got statement request result: ${JSON.stringify(res)}`);
            const statementFileName = SHARED_DIR + "/" + res.data
            await processLineByLine(statementFileName, async (line) => {
                // console.log(`From the statement: ${JSON.stringify(line)}`);
                transactions.push(MetadataWrapperValidator.parse(JSON.parse(line)));
            });
            fs.unlink(statementFileName, (err) => {});
            if (transactions.length >= expectedCount) break;
            await new Promise(r => setTimeout(r, 200));
            transactions.length = 0; // reset
        }
        return transactions;
    }
    async function testStatements(params: GenParameters) {
        const statFile = SHARED_DIR + '/' + (await getStat() as RequestResult).data;
        await processLineByLine(statFile, async (line) => {
            const counter = Counters.deserialise(line)
            // console.log(`Processing line: ${JSON.stringify(counter)}`);
            const statementParams = { userId: counter.userId, fromm: params.dateFrom, too: params.dateTo, type: StatementType.FS }
            const transactions: InKafkaMessage[] = 
                        await waitForTransactionsToBeDeliveredToDB(counter.transactionCount, statementParams);
            counter.minDate = Math.min(counter.minDate, params.dateFrom);
            counter.maxDate = Math.max(counter.maxDate, params.dateTo);
            checkStatement(transactions, counter);            
        },100);
    }
    function checkStatement(statements: InKafkaMessage[], epectedStats: Counters) {
        expect(statements.length).to.equal(epectedStats.transactionCount, `Expected ${epectedStats.transactionCount} statements, got ${statements.length}`);
        let lastDate = epectedStats.minDate;
        let amountSum = 0;
        const idSet = new Set<number>();
        for (const statement of statements) {
            const t = TransactionValidator.parse(statement.payload);
            expect(t.userIdFrom == epectedStats.userId || t.userIdTo == epectedStats.userId).to.be.eq(true, `wrong userId in transaction: ${t.userIdFrom} -> ${t.userIdTo} for user ${epectedStats.userId}`);
            expect(statement.payload.dateTime).to.be.greaterThanOrEqual(lastDate, `wrong date order: ${statement.payload.dateTime} after ${lastDate} for user ${epectedStats.userId}`);
            expect(idSet.has(t.id)).to.be.eq(false, `duplicate transaction id ${t.id} for user ${epectedStats.userId}`);
            expect(t.dateTime).to.be.at.least(epectedStats.minDate, `too early date: ${t.dateTime} < ${epectedStats.minDate} for user ${epectedStats.userId}`);
            expect(t.dateTime).to.be.at.most(epectedStats.maxDate, `too late date: ${t.dateTime} > ${epectedStats.maxDate} for user ${epectedStats.userId}`);
            idSet.add(t.id);
            amountSum += t.amount;
            lastDate = t.dateTime;
        }
        expect(Math.floor(amountSum)).to.equal(epectedStats.amountSum, `wrong amount sum: expected ${epectedStats.amountSum}, got ${amountSum} for user ${epectedStats.userId}`);
    }
    it(`Simple functional test`, async () => {
        logger.info(`Starting functional test with GRAPH_QL_HOSTNAME=${GRAPH_QL_HOSTNAME}, GRAPH_QL_PORT=${GRAPH_QL_PORT}, SHARED_DIR=${SHARED_DIR}`);
        for (const param of makeTestParams(10000, 1000000, 1, () => 1)) {
            await generateRecords(param);
            await testStatements(param);
        }
        // ok the only problem at this point is that after i read all the lines i might be still processing some statements...how to check it
        // leave a trace!
    });
})