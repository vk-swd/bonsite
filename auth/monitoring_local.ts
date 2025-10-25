import * as prom from 'prom-client'
import { logger } from './common/logger.js';
import { makeCounter, MonitoringServer, PromRegistryNamed } from "./common/monitoring.js";


export const localReg = new PromRegistryNamed("local", new prom.Registry());

class Metrics {
    constructor(
        public authRequests: prom.Counter,
        public authorisedActions: prom.Counter,
        public cfTokenRejectionCount: prom.Counter,
        public noClientIdCount: prom.Counter,
        public rateLimitedCount: prom.Counter,
        public usersAuthorised: prom.Counter,
        public usersExpired: prom.Counter,
        public wrongPasswords: prom.Counter,
        public loginAsyncErrors: prom.Counter,
        public loginRequests: prom.Counter) {
    }
}

export let metrics: Metrics | undefined = undefined;
let server : MonitoringServer | undefined = undefined;

export async function startMonitoring() {
    if (server !== undefined) {
        logger.warn("Monitoring server is already started");
        return;
    }
    metrics = new Metrics(
        await makeCounter('auth_requests_total', 'Total number of authentication requests', localReg),
        await makeCounter('authorised_actions_total', 'Total number of authorised actions', localReg),
        await makeCounter('cf_token_rejection_total', 'Total number of Cloudflare token rejections', localReg),
        await makeCounter('no_client_id_total', 'Total number of requests with no client ID', localReg),
        await makeCounter('rate_limited_total', 'Total number of rate limited requests', localReg),
        await makeCounter('users_authorised_total', 'Total number of users authorised', localReg),
        await makeCounter('users_expired_total', 'Total number of users with expired sessions', localReg),
        await makeCounter('wrong_passwords_total', 'Total number of wrong password attempts', localReg),
        await makeCounter('login_async_errors_total', 'Total number of asynchronous login errors', localReg),
        await makeCounter('login_requests_total', 'Total number of login requests', localReg)
    );
    server = new MonitoringServer(async () => {
        const metrics1 = await localReg.registry.metrics();
        return metrics1;
    });
}

export { dumpRegistry } from "./common/monitoring.js";
