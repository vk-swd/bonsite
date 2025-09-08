
import * as prom from 'prom-client'
import { Server, createServer } from 'http';
import { logger } from './logger.js';
import { getEnv } from './utils.js';
import * as fs from 'fs';

const PORT = getEnv("MONITORING_PORT");

export async function makeCounter(name: string, help: string, reg: prom.Registry): Promise<prom.Counter> {
    const counter = new prom.Counter({
        name,
        help,
        registers: [reg],
    });
    const restoredValue = (await getRestoredMetrics()).get(name);
    if (restoredValue !== undefined) {
        counter.inc(restoredValue);
    }
    return counter;
}

let restoredMetrics: Map<string, number> | undefined = undefined;
export async function getRestoredMetrics() {
    if (restoredMetrics === undefined) {
        restoredMetrics = await restoreRegistryFromDisk();
    }
    return restoredMetrics;
}
const LOCAL_REGISTRY_FILE_NAME = 'registry.json';
async function restoreRegistryFromDisk(): Promise<Map<string, number>> {
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

export async function dumpRegistry(localReg: prom.Registry | undefined = prom.register) {
    if (localReg == undefined) {
        logger.error("Registry is not initialized");
        return;
    }
    const registry = await localReg!.getMetricsAsJSON();
    await fs.writeFileSync(LOCAL_REGISTRY_FILE_NAME, JSON.stringify(registry, null, 2));
}

export class MonitoringServer {
    private server: Server;
    constructor(scrape: () => Promise<string>) {
        this.server = createServer(async (req, res) => {
            if (req.url === '/metrics') {
                res.setHeader('Content-Type', prom.register.contentType);
                res.writeHead(200);
                scrape().then((data) => {
                    res.end(data);
                    logger.info("Scraped metrics");
                }).catch((err) => {
                    res.writeHead(500);
                    res.end("Error collecting metrics: " + err);
                });
            }
        });
        this.server.listen(PORT, () => {
            logger.log(`Listening on http://localhost:${PORT}, metrics on /metrics`);
        });
    }
    updateMetrics() {
        // This method can be used to update metrics if needed
        // For example, you can call prom.register.metrics() to get the current metrics
        logger.log("Metrics updated");
    }
}



// const cnt1 = new prom.Counter({name: "testCounter", help: "beresh i countish"});