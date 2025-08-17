import { getEnv, last, RangeSet, testRangeSet } from './common/utils.js';
import { describe, it } from 'mocha'
// addint as promised
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { exit } from 'process';
import { logger } from './common/logger.js';
import { error } from 'console';
chai.use(chaiAsPromised);
chai.config.includeStack = true;




describe('Kafka Consumer Tests', function () {
    it.only(`Simple functional test`, async () => {
        expect(true).to.be.true;
    });
})