
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { describe, it } from 'mocha'
import { z, ZodType } from 'zod';
// addint as promised
import chai, { expect, util } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { logger } from './common/logger.js';
import { GqlServer } from './api.js';
import { handleRequest, MetricStats } from './common/apiRequestHandler.js';
import { postTransactionsUrl, reqStatementUrl, reqUsersUrl, StatementParameters, StatementParametersValidator, UserDataRequestParameters, UserDataRequestValidator, UserDataResult, UserDataResultValidator } from './common/event_types.js';
import { getGeneratorStats, getProgress, getStatement, postTransaction, startGen, stopGen, users } from './common/gqlDeclarations.js';
import { GenParameters, GenParametersValidator, startUrl, stopUrl } from './common/generator_parameters.js';
import { GenerationState, getStatUrl, PostTransactionParams, PostTransactionValidator, ProgressReport, progressUrl } from './common/generator_parameters.js';
import { defaulResponse } from './schema.js';
// import fetch from 'node-fetch';
chai.use(chaiAsPromised);
chai.config.includeStack = true;
chai.config.truncateThreshold = 10000


let gqlServer: GqlServer
let mocServer: Server
let apiCount = 0;
let unknowonApiCount = 0;
let failedApiCount = 0;
let maxResponseDelayMs = 0;
const mon: MetricStats = {
    incrementApiCallCount: () => apiCount++,
    incrementUnknownApiCallCount: () => unknowonApiCount++,
    incrementFailedApiCallCount: () => failedApiCount++,
    updateMaxResponseDelayMs: (value: number) => { if (value > maxResponseDelayMs) maxResponseDelayMs = value; }
};

const userRequestParams: UserDataRequestParameters = {
    cursor: 0,
    count: 10,
    pattern: "user_"
};
function makeHandler<T, K>(url: string, result: K, argCheckers?: {v: z.ZodType<T>, val: T}) {
    return (req: IncomingMessage, res: ServerResponse) =>
        handleRequest('/' + url, req, res, async (data?: string) => {
            if (argCheckers) {
                const params = argCheckers.v.parse(JSON.parse(data!))
                expect(params).to.deep.equal(argCheckers.val);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.write(typeof result == "string" ? result : JSON.stringify(result));
            res.end();
        }, mon);
}

function makeSuperUniqueUserList(params: UserDataRequestParameters): UserDataResult {
    return UserDataResultValidator.parse({
        slice: Array.from({ length: params.count }, (_, i) => ({
            cursor: params.cursor! + i,
            name: params.pattern + `${i}`,
            id: params.cursor! + i
        })),
        totalCount: 1000000
    });
}

const handleUserReq = makeHandler(reqUsersUrl, makeSuperUniqueUserList(userRequestParams),
    {v: UserDataRequestValidator, val: userRequestParams});

const handleStop = makeHandler(stopUrl, defaulResponse);

const progressReport: ProgressReport = {
    totalSent: 234567234567234567,
    generated: 10000001000000100000,
    percentComplete: 13,
    isRunning: GenerationState.RUNNING,
    maxUserId: 12310000100000010000045,
    maxTransactionId: 20000001000000100000
}
const handleGetProgress = makeHandler(progressUrl, progressReport);

const statReport = "someFilePath.json"
const handleGetStat = makeHandler(getStatUrl, statReport);

const postTransactionParams: PostTransactionParams = {
    amount: 67890,
    date: 1000,
    userFrom: 12345,
    userTo: 54321
}
const handlePostTransaction = makeHandler(postTransactionsUrl, defaulResponse,
    {v: PostTransactionValidator, val: postTransactionParams});

const statementParams: StatementParameters = {
    userId: 12345,
    fromm: 1000,
    too: 2000,
    type: 1
}
const expectedStatementResult = "statementData.json"
const handleStatementRequest = makeHandler(reqStatementUrl, expectedStatementResult,
    {v: StatementParametersValidator, val: statementParams});

const genParams: GenParameters = {
    userCount: 1000,
    dateFrom: new Date("2020-01-01").getTime(),
    dateTo: new Date("2023-01-01").getTime(),
    transactionCount: 10000,
    maxDelayMs: 10,
    minUserId: 5,
    minTransactionId: 10
}
const handleGenStart = makeHandler(startUrl, defaulResponse,
    {v: GenParametersValidator, val: genParams});
describe('Kafka Consumer Tests', function () {
    this.timeout(10000000); // Set timeout for the tests
    const apiPort = 7777;
    const gqlPort = 16666;
    const urlPath = '/graphql';
    const GQL_URL = `http://gql:${gqlPort}${urlPath}`;
    this.beforeAll(async () => {
        gqlServer = await GqlServer.create({
            port: gqlPort,
            url: urlPath,
            generatorAddress: `http://localhost:${apiPort}/`,
            statementGeneratorAddr: `http://localhost:${apiPort}/`
        });
        await new Promise<void>((resolve) => {
            mocServer = createServer((req, res) => {
                    console.log(`RECEIVING SOME REQUEST ${req.method} ${req.url}`)
                    mon.incrementApiCallCount();
                    if (handleUserReq(req, res)) return;
                    if (handleGenStart(req, res)) return;
                    if (handleStop(req, res)) return;
                    if (handleGetProgress(req, res)) return;
                    if (handleGetStat(req, res)) return;
                    if (handlePostTransaction(req, res)) return;
                    if (handleStatementRequest(req, res)) return;
                    console.log(`Unknown API call ${req.method} ${req.url}`);
                    res.writeHead(404);
                    res.end('Not Found');
                    mon.incrementUnknownApiCallCount();
                });
            mocServer.listen(apiPort, () => {
                console.log(`Server listening on port ${apiPort}`);
                resolve();
            });
        });
        logger.info(`Running a GraphQL API server at ${GQL_URL}`);
    });
    it(`Test normal case`, async () => {
        expect(await users.fetchCall(GQL_URL, userRequestParams)).to.deep.equal(makeSuperUniqueUserList(userRequestParams));
        expect(await startGen.fetchCall(GQL_URL, genParams)).to.equal(defaulResponse);
        expect(await stopGen.fetchCall(GQL_URL)).to.deep.equal(defaulResponse);
        expect(await getProgress.fetchCall(GQL_URL)).to.deep.equal(progressReport);
        expect(await getGeneratorStats.fetchCall(GQL_URL)).to.deep.equal(statReport);
        expect(await postTransaction.fetchCall(GQL_URL, postTransactionParams)).to.deep.equal(defaulResponse);
        expect(await getStatement.fetchCall(GQL_URL, statementParams)).to.deep.equal(expectedStatementResult);
        expect(apiCount).to.equal(7);
        expect(unknowonApiCount).to.equal(0);
        expect(failedApiCount).to.equal(0);
        expect(maxResponseDelayMs).to.be.greaterThan(0);
    })
});
