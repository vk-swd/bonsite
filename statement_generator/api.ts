import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { EventEmitter } from 'events';
import { getEnv } from './common/utils.js';
import { StatementParameters, StatementParametersValidator, UserDataRequestParameters, UserDataRequestValidator, UserDataResult, reqStatementUrl, reqUsersUrl } from './common/event_types.js';
import { rmSync } from 'fs';
import { metrics, updateMaxResponseDelayMs } from './monitoring_local.js';
import { handleRequest, MetricStats } from './common/apiRequestHandler.js';
// import * as mt from './monitoring_local.js'

const STATEMENT_GENERATOR_PORT = getEnv("STATEMENT_GENERATOR_PORT");

const metricCB: MetricStats = {
    incrementApiCallCount: () => metrics?.apiCallCount.inc(),
    updateMaxResponseDelayMs: (value: number) => updateMaxResponseDelayMs(value),
    incrementFailedApiCallCount: () => metrics?.apiError.inc(),
    incrementUnknownApiCallCount: () => metrics?.apiUnknown.inc()
}

export class StatementGenApiServer extends EventEmitter {
    private server: Server;
    handleUserReq(req: IncomingMessage, res: ServerResponse) : boolean {
        return handleRequest('/' + reqUsersUrl, req, res, async (data?: string) => {
            return this.getUsers(UserDataRequestValidator.parse(JSON.parse(data!)))
            .then(r => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.write(JSON.stringify(r));
                res.end();
                metrics?.apiSuccess.inc();
            })            
        }, metricCB);
    }
    handleStatementReq(req: IncomingMessage, res: ServerResponse, statementWriter: (p: StatementParameters) => Promise<string[]>) : boolean {
        return handleRequest('/' + reqStatementUrl, req, res, async (data?: string) => {
            return statementWriter(StatementParametersValidator.parse(JSON.parse(data!)))
            .then(r => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.write(JSON.stringify(r));
                res.end();
                metrics?.apiSuccess.inc();
            })            
        }, metricCB);
    }
    constructor(statementWriter: (p: StatementParameters) => Promise<string[]>, 
    private getUsers: (params: UserDataRequestParameters) => Promise<UserDataResult>) {
        super()
        this.server = createServer(async (req, res) => {
            console.log(`RECEIVING SOME REQUEST ${req.method} ${req.url}`)
            metrics?.apiCallCount.inc();
            if (this.handleUserReq(req, res)) return;
            if (this.handleStatementReq(req, res, statementWriter)) return;
            res.writeHead(404);
            res.end('Not Found');
            metrics?.apiUnknown.inc();
        });
        this.server.listen(STATEMENT_GENERATOR_PORT, () => {
            console.log(`Server listening on port ${STATEMENT_GENERATOR_PORT}`);
        })
    }
}
