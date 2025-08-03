import * as prom from 'prom-client'
import { logger } from './common/logger.js';
import { getRestoredMetrics } from "./common/monitoring.js";

export { MonitoringServer, dumpRegistry } from "./common/monitoring.js";
export const localReg: prom.Registry = new prom.Registry();


async function makeCounter(name: string, help: string): Promise<prom.Counter> {
    const counter = new prom.Counter({
        name,
        help,
        registers: [localReg],
    });
    const restoredValue = (await getRestoredMetrics()).get(name);
    if (restoredValue !== undefined) {
        counter.inc(restoredValue);
    }
    return counter;
}

export const dbDisconnectCount: prom.Counter = await makeCounter('kafka_failed_to_parse_messages', 'Number of times messages failed to parse');
export const crashCount: prom.Counter = await makeCounter('crash_count', 'Number of times application was killed manually');
export const kafkaConnectFailure: prom.Counter = await makeCounter('kafka_connect_failure', 'Number of times Kafka connection failed');
export const kafkaParseFailure: prom.Counter = await makeCounter('kafka_parse_failure', 'Number of times Kafka messages failed to parse');
export const kafkaDisconnectCount: prom.Counter = await makeCounter('kafka_disconnect_count', 'Number of times Kafka consumer disconnected');
export const kafkaRequestTimeout: prom.Counter = await makeCounter('kafka_connect_timeout', 'Number of times Kafka connection timed out');
export const dbConnectionFailure: prom.Counter = await makeCounter('db_connection_failure', 'Number of times database connection failed');
export const dbQueryFailure: prom.Counter = await makeCounter('db_query_failure', 'Number of times database query failed');
// export const networkRequestTOCount: prom.Counter = await makeCounter('kafka_network_request_timeout', 'Number of times network request timed out');
// export const networkRequestCount: prom.Counter = await makeCounter('kafka_failed_to_parse_messages', 'Number of times messages failed to parse');
// export const msgPosted: prom.Counter = await makeCounter('kafka_failed_to_parse_messages', 'Number of times messages failed to parse');


