import * as prom from 'prom-client'
import { logger } from './common/logger.js';
import { makeCounter, MonitoringServer } from "./common/monitoring.js";


export const localReg: prom.Registry = new prom.Registry();

class Metrics {
    constructor(
        public apiCallCount: prom.Counter,
        public failedApiCallCount: prom.Counter,
        public disconnectCount: prom.Counter,
        public networkRequestTOCount: prom.Counter,
        public networkRequestCount: prom.Counter,
        public msgPosted: prom.Counter,
        public msgSent: prom.Counter,
        public msgFailed: prom.Counter,
        public reconnectAttempts: prom.Counter,
        public retryCount: prom.Counter,
        public maxSendIntervalMs: prom.Gauge,
        public generatedTransactionId: prom.Gauge
    ) {}
}

export let metrics: Metrics | undefined = undefined;
let server : MonitoringServer | undefined = undefined;

export async function startMonitoring() {
    if (server !== undefined) {
        logger.warn("Monitoring server is already started");
        return;
    }
    metrics = new Metrics(
        await makeCounter('api_call_count', 'Number of API calls made to the generator', localReg),
        await makeCounter('api_failed_call_count', 'Number of failed API calls made to the generator', localReg),
        await makeCounter('kafka_producer_disconnect_count', 'Number of times the producer disconnected', localReg),
        await makeCounter('kafka_producer_network_request_timeout_count', 'Number of network request timeouts', localReg),
        await makeCounter('kafka_producer_network_request_count', 'Number of network requests made by the producer', localReg),
        await makeCounter('kafka_producer_msg_posted', 'Number of messages posted to the producer', localReg),
        await makeCounter('kafka_producer_msg_sent', 'Number of messages sent by the producer', localReg),
        await makeCounter('kafka_producer_msg_failed', 'Number of messages that failed to be sent by the producer', localReg),
        await makeCounter('kafka_producer_reconnect_attempts', 'Number of times the producer attempted to reconnect', localReg),
        await makeCounter('kafka_producer_retry_count', 'Number of retries made by the producer', localReg),
        new prom.Gauge({ name: 'kafka_producer_max_send_interval_ms', help: 'Maximum interval in milliseconds between sending messages', registers: [localReg] }),
        new prom.Gauge({ name: 'generatedTransactionId', help: 'id of last message produced by generator', registers: [localReg] })
    );
    server = new MonitoringServer(async () => {
        logger.info("Scraping metrics");
        const metrics = await localReg.metrics();
        return metrics;
    });
}
