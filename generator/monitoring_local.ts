import * as prom from 'prom-client'
import { logger } from './common/logger.js';
import { makeCounter, MaxCounter, MonitoringServer, PromRegistryNamed } from "./common/monitoring.js";


export const localReg = new PromRegistryNamed("local", new prom.Registry());

class Metrics {
    constructor(
        public apiCallCount: prom.Counter,
        public failedApiCallCount: prom.Counter,
        public unknownApiCallCount: prom.Counter,
        public connectCount: prom.Counter,
        public disconnectCount: prom.Counter,
        public networkRequestTOCount: prom.Counter,
        public networkRequestCount: prom.Counter,
        public msgPosted: prom.Counter,
        public msgSent: prom.Counter,
        public msgFailed: prom.Counter,
        public reconnectAttempts: prom.Counter,
        public retryCount: prom.Counter,
        public maxSendIntervalMs: MaxCounter,
        public generatedTransactionId: prom.Gauge,
        public maxResponseDelayMs: MaxCounter
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
        await makeCounter('api_calls_total', 'Number of API calls made to the generator', localReg),
        await makeCounter('api_error_total', 'Number of failed API calls made to the generator', localReg),
        await makeCounter('api_unknown_total', 'Number of unknown API calls made to the generator', localReg),

        await makeCounter('kafka_producer_connect_count', 'Number of times the producer connected', localReg),
        await makeCounter('kafka_producer_disconnect_count', 'Number of times the producer disconnected', localReg),
        await makeCounter('kafka_producer_network_request_timeout_count', 'Number of network request timeouts', localReg),
        await makeCounter('kafka_producer_network_request_count', 'Number of network requests made by the producer', localReg),
        await makeCounter('kafka_producer_msg_posted', 'Number of messages posted to the producer', localReg),
        await makeCounter('kafka_producer_msg_sent', 'Number of messages sent by the producer', localReg),
        await makeCounter('kafka_producer_msg_failed', 'Number of messages that failed to be sent by the producer', localReg),
        await makeCounter('kafka_producer_reconnect_attempts', 'Number of times the producer attempted to reconnect', localReg),
        await makeCounter('kafka_producer_retry_count', 'Number of retries made by the producer', localReg),
        await MaxCounter.make('kafka_producer_max_send_latency_ms', 'Maximum time taken to send a message in milliseconds', localReg),
        new prom.Gauge({ name: 'generatedTransactionId', help: 'id of last message produced by generator', registers: [localReg.registry] }),
        await MaxCounter.make('max_api_response_delay_ms', 'Maximum response delay in milliseconds', localReg)
    )
    server = new MonitoringServer(async () => {
        metrics?.maxResponseDelayMs.report();
        metrics?.maxSendIntervalMs.report();
        const metrics1 = await localReg.registry.metrics();
        return metrics1;
    });
}
