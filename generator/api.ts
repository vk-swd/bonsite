import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { EventEmitter } from 'events';
import { GenParametersValidator, ProgressReport, progressUrl, startUrl, getStatUrl, stopUrl } from './common/generator_parameters.js';
import { getEnv } from './common/utils.js';
import * as mt from './monitoring_local.js'
import { handleRequest } from './common/apiRequestHandler.js';
import { logger } from './common/logger.js';
import * as et from './common/event_types.js';
import { PostTransactionValidator } from './common/generator_parameters.js';

const GENERATOR_PORT = getEnv("GENERATOR_PORT");

const metricStats = {
    incrementApiCallCount: () => mt.metrics?.apiCallCount.inc(),
    updateMaxResponseDelayMs: (ms:number) => mt.updateMaxApiResponseDelayMs(ms),
    incrementFailedApiCallCount: () => mt.metrics?.failedApiCallCount.inc(),
    incrementUnknownApiCallCount: () => mt.metrics?.unknownApiCallCount.inc()
};

export class GenApiServer extends EventEmitter {
    private server: Server;
    public static event = {
        startGen: 'start',
        stopGen: 'stop',
        postTransaction: 'postTransaction'
    }
    handleStart(req: IncomingMessage, res: ServerResponse) : boolean {
        return handleRequest('/' + startUrl, req, res, async (data?: string) => {
            const parsedData = JSON.parse(data!);
            const params = GenParametersValidator.parse(parsedData);
            this.emit(GenApiServer.event.startGen, params);
            res.writeHead(200);
            res.end();
        }, metricStats);
    }
    handleStop(req: IncomingMessage, res: ServerResponse): boolean {
        return handleRequest('/' + stopUrl, req, res, async () => {
            this.emit(GenApiServer.event.stopGen);
            res.writeHead(200);
            res.end();
        }, metricStats);
    }
    handleGetProgress(req: IncomingMessage, res: ServerResponse): boolean {
        return handleRequest('/' + progressUrl, req, res, async () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(this.progressReporter()));
        }, metricStats);
    }
    handleGetStat(req: IncomingMessage, res: ServerResponse): boolean {
        return handleRequest('/' + getStatUrl, req, res, async () => {
            const r = await this.getStat()
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(r);
        }, metricStats);
    }
    handlePostTransaction(req: IncomingMessage, res: ServerResponse): boolean {
        return handleRequest('/' + et.postTransactionsUrl, req, res, async (data?: string) => {
            const parsedData = JSON.parse(data!);
            const params = PostTransactionValidator.parse(parsedData);
            this.emit(GenApiServer.event.postTransaction, params);
            res.writeHead(200);
            res.end();
        }, metricStats);
    }
    constructor(private progressReporter: () => ProgressReport, private getStat: () => Promise<string>) {
        super()
        this.server = createServer(async (req, res) => {
            logger.info(`RECEIVING SOME REQUEST ${req.url}`)
            metricStats.incrementApiCallCount();  
            if (this.handleStart(req, res)) return;
            if (this.handleStop(req, res)) return;
            if (this.handleGetProgress(req, res)) return;
            if (this.handleGetStat(req, res)) return;
            if (this.handlePostTransaction(req, res)) return;
            res.writeHead(404);
            res.end('Not Found');
            metricStats.incrementUnknownApiCallCount();
        });
        this.server.listen(GENERATOR_PORT, () => {
            logger.info(`Server listening on port ${GENERATOR_PORT}`);
        })
    }
}
