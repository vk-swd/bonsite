import * as prom from 'prom-client'
import { logger } from './common/logger.js';
import { makeCounter, MonitoringServer } from "./common/monitoring.js";


export const localReg: prom.Registry = new prom.Registry();

class Metrics {
    constructor(
        public serverSetUpFailed: prom.Counter,
        public requestCount: prom.Counter,
        public requestSuccess: prom.Counter,
        public requestError: prom.Counter,
        public maxResponseDelayMs: prom.Counter) {
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
        await makeCounter('request_error', 'Number of requests that resulted in an error', localReg),
        await makeCounter('max_response_delay_ms', 'Maximum response delay in milliseconds', localReg)
    );
    server = new MonitoringServer(async () => {
        logger.info("Scraping metrics");
        metrics?.maxResponseDelayMs.inc(maxApiResponseDelayMs);
        maxApiResponseDelayMs = 0;
        const metrics1 = await localReg.metrics();
        return metrics1;
    });
}
let maxApiResponseDelayMs = 0;
export function updateMaxApiResponseDelayMs(value: number) {
    if (value > maxApiResponseDelayMs) {
        maxApiResponseDelayMs = value;
    }
}
export { dumpRegistry } from "./common/monitoring.js";
