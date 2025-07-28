import * as prom from 'prom-client'
import * as fs from 'fs';
import { logger } from './common/logger.js';

export const localReg: prom.Registry = new prom.Registry();

const restoredMetrics = restoreRegistryFromDisk();

async function makeCounter(name: string, help: string): Promise<prom.Counter> {
    const counter = new prom.Counter({
        name,
        help,
        registers: [localReg],
    });
    const restoredValue = (await restoredMetrics).get(name);
    if (restoredValue !== undefined) {
        counter.inc(restoredValue);
    }
    return counter;
}
export const disconnectCount: prom.Counter = await makeCounter('kafka_failed_to_parse_messages', 'Number of times messages failed to parse');
export const crashCount: prom.Counter = await makeCounter('crash_count', 'Number of times application was killed manually');
// export const networkRequestTOCount: prom.Counter = await makeCounter('kafka_network_request_timeout', 'Number of times network request timed out');
// export const networkRequestCount: prom.Counter = await makeCounter('kafka_failed_to_parse_messages', 'Number of times messages failed to parse');
// export const msgPosted: prom.Counter = await makeCounter('kafka_failed_to_parse_messages', 'Number of times messages failed to parse');

const LOCAL_REGISTRY_FILE_NAME = 'registry.json';
async function restoreRegistryFromDisk() {
    // Some scrapes might might happen during recovery and miss most recent data.
    // Ideally metrics should also be pushed at a dedicated collecting service, together
    // with logs and other telemetry data. But it will not be implemented in this demo..
    const res = new Map<string, number>();
    try {
        const data = await fs.readFileSync(LOCAL_REGISTRY_FILE_NAME, 'utf8');
        const metrics = JSON.parse(data);
        metrics.forEach((metric: any) => {
            res.set(metric.name, metric.values[0].value);
        });
    } catch (e) {
        logger.error("Failed to read registry from disk:" + e);
    }
    return res;
}

export async function dumpRegistry() {
    if (localReg == undefined) {
        logger.error("Registry is not initialized");
        return;
    }
    const registry = await localReg!.getMetricsAsJSON();
    await fs.writeFileSync(LOCAL_REGISTRY_FILE_NAME, JSON.stringify(registry, null, 2));
}

export { MonitoringServer } from "./common/monitoring.js";