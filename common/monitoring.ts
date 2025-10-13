
import * as prom from 'prom-client'
import { Server, createServer } from 'http';
import { logger } from './logger.js';
import { getEnv } from './utils.js';
import * as fs from 'fs';

const PORT = getEnv("MONITORING_PORT");

export class PromRegistryNamed {
    constructor(
        public name: string,
        public registry: prom.Registry
    ) {}
}
export class MaxCounter {
    static async make(name: string, help: string, reg: PromRegistryNamed): Promise<MaxCounter> {
        const counter = await makeCounter(name, help, reg);
        return new MaxCounter(counter);
    }
    private value: number = 0;
    constructor(
        private counter: prom.Counter
    ) {}
    public set(value: number) {
        if (value > this.value) {
            this.value = value;
        }
    }
    public report() {
        this.counter.reset();
        this.counter.inc(this.value);
        this.value = 0;
    }
}
export async function makeCounter(name: string, help: string, reg: PromRegistryNamed): Promise<prom.Counter> {
    const counter = new prom.Counter({
        name,
        help,
        registers: [reg.registry],
    });
    const restoredValue = (await getRestoredMetrics(reg.name)).get(name);
    if (restoredValue !== undefined) {
        counter.inc(restoredValue);
    }
    return counter;
}

let restoredMetrics: Map<string, number> | undefined = undefined;
async function getRestoredMetrics(regName: string) {
    if (restoredMetrics === undefined) {
        restoredMetrics = await restoreRegistryFromDisk(regName + "_metrics.json");
    }
    return restoredMetrics;
}
async function restoreRegistryFromDisk(fileName: string): Promise<Map<string, number>> {
    // Some scrapes might might happen during recovery and miss most recent data.
    // Ideally metrics should also be pushed at a dedicated collecting service, together
    // with logs and other telemetry data. But it will not be implemented in this demo..
    const res = new Map<string, number>();
    try {
        const data = await fs.readFileSync(fileName, 'utf8');
        const metrics = JSON.parse(data);
        metrics.forEach((metric: any) => {
            res.set(metric.name, metric.values[0].value);
        });
    } catch (e) {
        logger.error("Failed to read registry from disk:" + e);
    }
    return res;
}

export async function dumpRegistry(localReg: PromRegistryNamed) {
    // TODO: add a crash handler for this.
    // Originally it was made for scheduled crashes in message sink
    if (localReg == undefined) {
        logger.error("Registry is not initialized");
        return;
    }
    const registry = await localReg.registry!.getMetricsAsJSON();
    await fs.writeFileSync(localReg.name + `.json`, JSON.stringify(registry, null, 2));
}

export const coreReg = new PromRegistryNamed("core", new prom.Registry());
const maxScrapeInterval = await MaxCounter.make('max_scrape_interval_ms', 'Maximum time taken between scrape requests in milliseconds', coreReg);
const maxScrapeResponseIntervalLagged = await MaxCounter.make('max_scrape_response_interval_lagged_ms', 'Maximum time taken to respond to a scrape request in milliseconds. Lagged, because its calculation is finished after the end of a current response and will be reported on the next scrape.', coreReg);
const metricCollectionErrors = await makeCounter('metric_collection_errors_total', 'Number of errors occurred during metric collection', coreReg);
export class MonitoringServer {
    private server: Server;
    private lastScrapeTime: number | undefined = undefined;
    constructor(scrape: () => Promise<string>) {
        this.server = createServer(async (req, res) => {
            const now = Date.now();
            if (this.lastScrapeTime !== undefined) {
                const interval = now - this.lastScrapeTime;
                maxScrapeInterval.set(interval);
            }
            this.lastScrapeTime = now;
            req.on('close', () => {
                maxScrapeResponseIntervalLagged.set(Date.now() - now);
            });
            if (req.url === '/metrics') {
                res.setHeader('Content-Type', prom.register.contentType);
                res.writeHead(200);
                scrape().then((data) => {
                    maxScrapeInterval.report();
                    maxScrapeResponseIntervalLagged.report();
                    return coreReg.registry.metrics().then((coreData) => {
                        res.end(coreData + '\n' + data);
                    });
                }).catch((err) => {
                    res.writeHead(500);
                    metricCollectionErrors.inc();
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