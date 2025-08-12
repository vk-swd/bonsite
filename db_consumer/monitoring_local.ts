import * as prom from 'prom-client'
import { logger } from './common/logger.js';
import { getRestoredMetrics, makeCounter } from "./common/monitoring.js";


export const localReg: prom.Registry = new prom.Registry();


export const dbDisconnectCount = await makeCounter('kafka_failed_to_parse_messages', 'Number of times messages failed to parse', localReg);
export const crashCount = await makeCounter('crash_count', 'Number of times application was killed manually', localReg);
export const kafkaConnectFailure = await makeCounter('kafka_connect_failure', 'Number of times Kafka connection failed', localReg);
export const kafkaSubscribeFailure = await makeCounter('kafka_subscribe_failure', 'Number of times Kafka subscription failed', localReg);
export const kafkaParseFailure = await makeCounter('kafka_parse_failure', 'Number of times Kafka messages failed to parse', localReg);
export const kafkaDisconnectCount = await makeCounter('kafka_disconnect_count', 'Number of times Kafka consumer disconnected', localReg);
export const kafkaIncomingMessageCount = await makeCounter('kafka_incoming_message_count', 'Number of incoming messages from Kafka', localReg);
export const kafkaRequestTimeout = await makeCounter('kafka_connect_timeout', 'Number of times Kafka connection timed out', localReg);
export const dbKnownMessageWritten = await makeCounter('db_known_message_count', 'Number of known messages in the database', localReg);
export const dbUnknownMessageWritten = await makeCounter('db_unknown_message_count', 'Number of unknown messages in the database', localReg);
export const dbRollbackCount = await makeCounter('db_rollback_count', 'Number of times database transaction was rolled back', localReg);
export const dbConnectionFailure = await makeCounter('db_connection_failure', 'Number of times database connection failed', localReg);
export const dbQueryFailure = await makeCounter('db_query_failure', 'Number of times database query failed', localReg);
// export const networkRequestTOCount: prom.Counter = await makeCounter('kafka_network_request_timeout', 'Number of times network request timed out');
// export const networkRequestCount: prom.Counter = await makeCounter('kafka_failed_to_parse_messages', 'Number of times messages failed to parse');
// export const msgPosted: prom.Counter = await makeCounter('kafka_failed_to_parse_messages', 'Number of times messages failed to parse');


export { MonitoringServer, dumpRegistry } from "./common/monitoring.js";
