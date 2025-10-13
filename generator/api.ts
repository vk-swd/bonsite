import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { EventEmitter } from 'events';
import { GenParametersValidator, ProgressReport, progressUrl, startUrl, getStatUrl, stopUrl, PostTransactionParams, GenRequestError } from './common/generator_parameters.js';
import { getEnv } from './common/utils.js';
import * as mt from './monitoring_local.js'
import { handleRequest } from './common/apiRequestHandler.js';
import { logger } from './common/logger.js';
import * as et from './common/event_types.js';
import { PostTransactionValidator } from './common/generator_parameters.js';

const GENERATOR_PORT = getEnv("GENERATOR_PORT");

const metricStats = {
    incrementApiCallCount: () => mt.metrics?.apiCallCount.inc(),
    updateMaxResponseDelayMs: (ms:number) => mt.metrics?.maxResponseDelayMs.set(ms),
    incrementFailedApiCallCount: () => mt.metrics?.failedApiCallCount.inc(),
    incrementUnknownApiCallCount: () => mt.metrics?.unknownApiCallCount.inc()
};

export class GenApiServer extends EventEmitter {
    private server: Server;
    public static event = {
        startGen: 'start',
        stopGen: 'stop'
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
            this.getStat().then(r => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(r);
            }).catch(e => {
                res.writeHead(500);
                res.end(JSON.stringify(e));
            });
        }, metricStats);
    }
    handlePostTransaction(req: IncomingMessage, res: ServerResponse): boolean {
        return handleRequest('/' + et.postTransactionsUrl, req, res, async (data?: string) => {
            try {
                const parsedData = JSON.parse(data!);
                const params = PostTransactionValidator.parse(parsedData);
                this.postTransaction(params);
                res.writeHead(200);
                res.end();
            } catch (e) {
                if (e instanceof GenRequestError) {
                    res.writeHead(500, "Content-Type: application/json");
                    res.end(e.toString());
                } else {
                    throw e;
                }
            }
        }, metricStats);
    }
    constructor(private progressReporter: () => ProgressReport, 
                private getStat: () => Promise<string>,
                private postTransaction: (userData: PostTransactionParams) => void) {
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
