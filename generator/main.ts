import { GenParameters } from "./common/generator_parameters.js";
import { GenApiServer } from "./api.js";
import { startMonitoring } from "./monitoring_local.js";
import { Sender } from "./sender.js";
import { HealthCheckSever } from "./common/healthcheck.js";
import fs from 'fs';
import { getEnv } from "./common/utils.js";
import { logger } from "./common/logger.js";
await startMonitoring();
const sender = new Sender();

let requestCount = 0;
const SHARED_DIR = getEnv('SHARED_DIR');
const api = new GenApiServer(() => sender.progress(), () => {
    logger.info(`Generating stats to shared storage in ${SHARED_DIR}`);
    const statsToSave = sender.generator.getStat().serialise();
    const fileName = `${requestCount++}-${Date.now()}.json`;
    return new Promise((resolve, reject) => {
        fs.writeFile(SHARED_DIR + "/" + fileName, statsToSave, (err) => {
            if (err) {
                console.error(`Error writing stats to file ${fileName}:`, err);
                reject(err);
                return;
            }
            resolve(fileName);
        })
    });
});
api.on('start', (p: GenParameters) => {
    console.log("Starting sender signaled by API with params", p);
    sender.start(p);  
} );
api.on('stop', () => {sender.stop();});

const healthCheckServer = new HealthCheckSever();