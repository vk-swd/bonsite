import * as prom from 'prom-client'
import { logger } from '../common/logger.js';
import { MaxCounter, MonitoringServer, PromRegistryNamed, makeCounter } from "../common/monitoring.js";

export const localReg = new PromRegistryNamed("local", new prom.Registry());

class Metrics {
    constructor(
        public apiCallCount: prom.Counter,
        public apiSuccess: prom.Counter,
        public apiError: prom.Counter,
        public apiUnknown: prom.Counter,
        public statementRequestCount: prom.Counter,
        public servedStatementsCount: prom.Counter,
        public maxResponseDelayMs: MaxCounter,
        public servedTransactionRecords: prom.Counter,
        public filesGenerated: prom.Counter,
        public databaseRequests: prom.Counter,
        public databaseRequestErrors: prom.Counter,
        public fileWriteErrors: prom.Counter,
        public transactionsRetrieved: prom.Counter
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
        await makeCounter('api_calls_total', 'Number of API calls received', localReg),
        await makeCounter('api_success_total', 'Number of successful API calls', localReg),
        await makeCounter('api_error_total', 'Number of API calls that resulted in an error', localReg),
        await makeCounter('api_unknown_total', 'Number of API calls that resulted in an unknown status', localReg),
        await makeCounter('statement_requests_total', 'Number of statement requests received', localReg),
        await makeCounter('served_statements_total', 'Number of statements served', localReg),
        await MaxCounter.make('max_api_response_delay_ms', 'Maximum response delay in milliseconds', localReg),
        await makeCounter('served_transaction_records_total', 'Number of transaction records served', localReg),
        await makeCounter('files_generated_total', 'Number of files generated', localReg),
        await makeCounter('database_requests_total', 'Number of database requests made', localReg),
        await makeCounter('database_request_errors_total', 'Number of database request errors', localReg),
        await makeCounter('file_write_errors_total', 'Number of file write errors', localReg),
        await makeCounter('transactions_retrieved_total', 'Number of transactions retrieved from database', localReg)
    );
    server = new MonitoringServer(async () => {
        logger.info("Scraping metrics");
        metrics?.maxResponseDelayMs.report();
        const metrics1 = await localReg.registry.metrics();
        return metrics1;
    });
}


export { dumpRegistry } from '../common/monitoring.js';