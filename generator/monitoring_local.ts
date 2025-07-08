import * as prom from 'prom-client'
import { KProducer } from './common/kafka_client.js';
import { Sender } from './sender.js';

const localReg = new prom.Registry();
const disconnectCount = new prom.Counter({
    name: 'kafka_producer_disconnect_count',
    help: 'Number of times the producer disconnected',
    registers: [localReg],
});
const networkRequestTOCount = new prom.Counter({
    name: 'kafka_producer_network_request_timeout_count',
    help: 'Number of network request timeouts',
    registers: [localReg],
});
const networkRequestCount = new prom.Counter({
    name: 'kafka_producer_network_request_count',
    help: 'Number of network requests made by the producer',
    registers: [localReg],
});
const msgPosted = new prom.Counter({
    name: 'kafka_producer_msg_posted',
    help: 'Number of messages posted to the producer',
    registers: [localReg],
});
const msgSent = new prom.Counter({
    name: 'kafka_producer_msg_sent',
    help: 'Number of messages sent by the producer',
    registers: [localReg],
});
const msgFailed = new prom.Counter({
    name: 'kafka_producer_msg_failed',
    help: 'Number of messages that failed to be sent by the producer',
    registers: [localReg],
});
const reconnectAttempts = new prom.Counter({
    name: 'kafka_producer_reconnect_attempts',
    help: 'Number of times the producer attempted to reconnect',
    registers: [localReg],
});
const retryCount = new prom.Counter({
    name: 'kafka_producer_retry_count',
    help: 'Number of retries made by the producer',
    registers: [localReg],
});
const maxSendIntervalMs = new prom.Gauge({
    name: 'kafka_producer_max_send_interval_ms',
    help: 'Maximum interval in milliseconds between sending messages',
    registers: [localReg],
});


export function readMetrics(producer: KProducer, sender: Sender) {
    disconnectCount.inc(producer.stats.disconnectCount);
    networkRequestTOCount.inc(producer.stats.networkRequestTOCount);
    networkRequestCount.inc(producer.stats.networkRequestCount);
    msgPosted.inc(producer.stats.msgPosted);
    msgSent.inc(producer.stats.msgSent);
    msgFailed.inc(producer.stats.msgFailed);
    reconnectAttempts.inc(producer.stats.reconnectAttempts);
    retryCount.inc(producer.stats.retryCount);
    maxSendIntervalMs.set(sender.stats.maxSendIntervalMs);
    // Reset stats after reading
    producer.stats.disconnectCount = 0;
    producer.stats.networkRequestTOCount = 0;
    producer.stats.networkRequestCount = 0;
    producer.stats.msgPosted = 0;
    producer.stats.msgSent = 0;
    producer.stats.msgFailed = 0;
    producer.stats.reconnectAttempts = 0;
    producer.stats.retryCount = 0;
    sender.stats.maxSendIntervalMs = 0;
}

export { MonitoringServer } from "./common/monitoring.js";