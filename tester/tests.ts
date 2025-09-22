import { getEnv } from './common/utils.js';
import { describe, it } from 'mocha'
// addint as promised
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { logger } from './common/logger.js';
import { GenerationState, GenParameters, ProgressReportValidator, ProgressReport, RequestResult, UserCounters, Counters } from './common/generator_parameters.js';
import z, { ZodType } from 'zod';
import { gql } from 'graphql-request'
import * as fsp from 'fs/promises';
import { Deferred } from './common/utils.js';

import { InKafkaMessage, MetadataWrapperValidator, StatementParameters, StatementType, Transaction, TransactionValidator } from './common/event_types.js';
import { processLineByLine } from './common/files.js';
import { getRandomValues } from 'crypto';
import { ProgressPrinter } from './common/utils.js';
import { getGeneratorStats, getProgress, getStatement, startGen, stopGen } from './common/gqlDeclarations.js';
import { generateRecords, GQL_URL, GRAPH_QL_HOSTNAME, makeTestParams, SHARED_DIR, testStatements, waitForTransactionsToBeDeliveredToDB } from './test_helpers.js';

chai.use(chaiAsPromised);
chai.config.includeStack = true;




describe('Kafka Consumer Tests', function () {
    this.timeout(1000000); // set timeout for the tests
    it('', async () => {
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
        const runCount = 2;
        const params = makeTestParams(10000, 1000000, runCount, () => Math.random());
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
    it(`ui exposed functionality test`, async() => {
        //request n rows from an id and a regular expression
    })
})