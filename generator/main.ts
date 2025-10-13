import { GenParameters, GenRequestError, GenRequestErrorType } from "./common/generator_parameters.js";
import { GenApiServer } from "./api.js";
import { startMonitoring } from "./monitoring_local.js";
import { Sender } from "./sender.js";
import { HealthCheckSever } from "./common/healthcheck.js";
import fs from 'fs';
import { getEnv } from "./common/utils.js";
import { logger } from "./common/logger.js";
import { PostTransactionParams } from "./common/generator_parameters.js";
await startMonitoring();
const sender = new Sender();

let requestCount = 0;
const SHARED_DIR = getEnv('SHARED_DIR');
function getProgress() {
    return sender.progress();
}
function getStat(): Promise<string> {
    logger.info(`Generating stats to shared storage in ${SHARED_DIR}`);
    const statsToSave = sender.generator.getStat().serialise();
    const fileName = `${requestCount++}-${Date.now()}.json`;
    return new Promise((resolve, reject) => {
        fs.writeFile(SHARED_DIR + "/" + fileName, statsToSave, (err) => {
            if (err) {
                logger.error(`Error writing stats to file ${fileName}: ` + err);
                reject(new GenRequestError(`Error writing stats to file ${fileName}: ` + err, GenRequestErrorType.STAT_REQUEST_ERROR));
                return;
            }
            resolve(fileName);
        })
    });
}
function postTransaction(params: PostTransactionParams): Promise<void> {
    return sender.postTransaction(params);
}
const api = new GenApiServer(getProgress, getStat,postTransaction);
api.on(GenApiServer.event.startGen, (p: GenParameters) => {
    logger.log("Starting sender signaled by API with params" + JSON.stringify(p));
    sender.start(p);
});
api.on(GenApiServer.event.stopGen, () => {sender.stop();});

const healthCheckServer = new HealthCheckSever();