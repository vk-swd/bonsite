import * as prom from 'prom-client'
import { logger } from './common/logger.js';
import { makeCounter, MonitoringServer } from "./common/monitoring.js";


export const localReg: prom.Registry = new prom.Registry();

class Metrics {
    constructor(
        public serverSetUpFailed: prom.Counter,
        public requestCount: prom.Counter,
        public requestSuccess: prom.Counter,
        public requestError: prom.Counter) {
    }
}

export let metrics: Metrics | undefined = undefined;
let server : MonitoringServer | undefined = undefined;

export async function startMonitoring() {
    if (server !== undefined) {
        logger.warn("Monitoring server is already started");
        return;
    }
    metrics = new Metrics(
        await makeCounter('server_setup_failed', 'Number of times server setup failed', localReg),
        await makeCounter('request_count', 'Number of requests received', localReg),
        await makeCounter('request_success', 'Number of successful requests', localReg),
        await makeCounter('request_error', 'Number of requests that resulted in an error', localReg)
    );
    server = new MonitoringServer(async () => {
        logger.info("Scraping metrics");
        const metrics = await localReg.metrics();
        return metrics;
    });
}

export { dumpRegistry } from "./common/monitoring.js";
