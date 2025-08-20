import { getEnv } from './common/utils.js';
import { describe, it } from 'mocha'
// addint as promised
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { logger } from './common/logger.js';
import { GenerationState, GenParameters, ProgressReportValidator, ProgressReport, RequestResult, UserCounters } from './common/generator_parameters.js';
import { RequestResultValidator, RequestStatus } from './common/generator_parameters.js';
import z, { ZodType } from 'zod';
import { gql } from 'graphql-request'
import fs from 'fs'
import { StatementParameters } from './common/event_types.js';

chai.use(chaiAsPromised);
chai.config.includeStack = true;


const GRAPH_QL_HOSTNAME = getEnv("GRAPH_QL_HOSTNAME");
const GRAPH_QL_PORT = getEnv("GRAPH_QL_PORT");
const SHARED_DIR = getEnv('SHARED_DIR');

describe('Kafka Consumer Tests', function () {
    this.timeout(10000); // set timeout for the tests
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
    it(`Simple functional test`, async () => {
        await stopGen(); // stop any previous generation
        const params: GenParameters = {
            userCount: 1,
            dateFrom: 100,
            dateTo: 1000,
            transactionCount: 5,
            maxDelayMs: 200,
            minUserId: 15
        };
        const results = await startGen(params) as RequestResult;
        expect(results.status, `bad status in ${JSON.stringify(results)}`).to.equal(RequestStatus.OK);

        // await request('https://api.spacex.land/graphql/', document)
        while (true) {
            const progress = await getProgress() as ProgressReport;
            if (progress.isRunning === GenerationState.STOPPED) {
                console.log("Generation stopped.");
                break;
            }
            
            console.log(`Progress: ${JSON.stringify(progress)}`);
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        const stat = await getStat();
        expect(stat.status, `bad status in ${JSON.stringify(stat)}`).to.equal(RequestStatus.OK);
        
        const readStats = await fs.readFileSync(SHARED_DIR + "/" + stat.data);
        const stats = UserCounters.deserialise(readStats.toString());
        console.log(`readStats: ${Array.from(stats.data.entries()).map((d) => `${d[0]}: ${d[1].transactionCount}`).join(", ")}`);
        /*
            Iterate users and make a request for each.
            IF i get non-complete list for some user - schedul re request for later
            then get maximum delay from remaining users and 
            Actually, i will do this sequentially, no need to emulate super effeciency here.
            Might want to explore this  idea of concurrency in http server later. 
            It is called load pallancing. It is implemented in nginx and in later apache versions.
            where polling is used instead of running a thread per request.
        Ok, to keep thngs going, make a separate event handling for data request and then separate for 
        its processing so that tester and generator don't block each other.
        */
        
        const userIds = Array.from(stats.data.entries());
        
        for (const data of stats.data) {
            const userId = data[0]
            const counters = data[1];
            
        }

        while (userIds.length>0) {
            const sFiles = await Promise.all(userIds.map(async userId => {
                const statFile = await getStatement({ userId: userId[0] })
                const readStats = JSON.parse(await fs.readFileSync(SHARED_DIR + "/" + statFile.data).toString());
                console.log(`readStats: ${readStats} for user ${userId[0]} with counters: ${
                    JSON.stringify(userId[1])}`);
                return userId[1].transactionCount != readStats.length;
            }));
            if (sFiles.length === 0) {
                console.log("No more users to process.");
                break;
            }
            await new Promise((r) => setTimeout(r, 1000)); // wait for a second before next request
        }
    });
})