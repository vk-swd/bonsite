
import { describe, it } from 'mocha'
import chai from 'chai';
import { testGeneratorContinuous } from "./generator.js";

chai.config.includeStack = true;
chai.config.truncateThreshold = 10000

describe('Test generator components', function () {
    this.timeout(10000000); // Set a timeout for the test, adjust as needed
    it('Check generated records are ordered', async function () {
        await testGeneratorContinuous(10, 10000); // Run the generator test with 10 cycles and 1000 events per cycle
    });
});