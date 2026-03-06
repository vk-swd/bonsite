import * as prom from 'prom-client'
import { logger } from '../common/logger.js';
import { MaxCounter, MonitoringServer, PromRegistryNamed, makeCounter } from "../common/monitoring.js";

export const localReg = new PromRegistryNamed("local", new prom.Registry());

class Metrics {
    constructor(
        public dbDisconnectCount: prom.Counter,
        public crashCount: prom.Counter,
        public kafkaConnectFailure: prom.Counter,
        public kafkaSubscribeFailure: prom.Counter,
        public kafkaParseFailure: prom.Counter,
        public kafkaDisconnectCount: prom.Counter,
        public kafkaIncomingMessageCount: prom.Counter,
        public kafkaRequestTimeout: prom.Counter,
        public kafkaRowsRotated: prom.Counter,
        public kafkaOldRecordsArrived: prom.Counter,
        public kafkaMaxFetchDelay: MaxCounter,
        public dbKnownMessageWritten: prom.Counter,
        public dbUnknownMessageWritten: prom.Counter,
        public dbRollbackCount: prom.Counter,
        public dbConnectionFailure: prom.Counter,
        public dbQueryFailure: prom.Counter,
        public dbRowsRotated: prom.Counter,
        public kafkaProcessingFailed: prom.Counter,
        public maxFetchProcessingDelayMs: MaxCounter,
        public maxFetchFullProcessingDelayMs: MaxCounter
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
        await makeCounter('kafka_failed_to_parse_messages', 'Number of times messages failed to parse', localReg),
        await makeCounter('crash_count', 'Number of times application was killed manually', localReg),
        await makeCounter('kafka_connect_failure', 'Number of times Kafka connection failed', localReg),
        await makeCounter('kafka_subscribe_failure', 'Number of times Kafka subscription failed', localReg),
        await makeCounter('kafka_parse_failure', 'Number of times Kafka messages failed to parse', localReg),
        await makeCounter('kafka_disconnect_count', 'Number of times Kafka consumer disconnected', localReg),
        await makeCounter('kafka_incoming_message_count', 'Number of incoming messages from Kafka', localReg),
        await makeCounter('kafka_connect_timeout', 'Number of times Kafka connection timed out', localReg),
        await makeCounter('kafka_rows_rotated', 'Number of rows removed from Kafka topic to save space', localReg),
        await makeCounter('kafka_old_records_arrived', 'Number of times old records arrived from Kafka (possible reprocessing)', localReg),
        await MaxCounter.make('kafka_max_fetch_delay', 'Maximum delay in milliseconds between fetch and processing', localReg),
        await makeCounter('db_known_message_count', 'Number of known messages in the database', localReg),
        await makeCounter('db_unknown_message_count', 'Number of unknown messages in the database', localReg),
        await makeCounter('db_rollback_count', 'Number of times database transaction was rolled back', localReg),
        await makeCounter('db_connection_failure', 'Number of times database connection failed', localReg),
        await makeCounter('db_query_failure', 'Number of times database query failed', localReg),
        await makeCounter('db_rows_rotated', 'Number of rows removed to save space', localReg),
        await makeCounter('fetch_processing_failed', 'Number of times fetched messages could not be processed down the line', localReg),
        await MaxCounter.make('max_fetch_processing_delay_ms', 'Maximum fetch process delay in milliseconds', localReg),
        await MaxCounter.make('max_fetch_full_processing_delay_ms', 'Maximum fetch processing delay in milliseconds including errors', localReg)
    );
    server = new MonitoringServer(async () => {
        metrics?.maxFetchProcessingDelayMs.report();
        metrics?.maxFetchFullProcessingDelayMs.report();
        metrics?.kafkaMaxFetchDelay.report();
        const metrics1 = await localReg.registry.metrics();
        return metrics1;
    });
}

export { dumpRegistry } from '../common/monitoring.js';


