import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { EventEmitter } from 'events';
import { GenParametersValidator, ProgressReport, progressUrl, startUrl, getStatUrl, stopUrl, RequestStatus } from './common/generator_parameters.js';
import { getEnv } from './common/utils.js';
import * as mt from './monitoring_local.js'
import { handleRequest } from './common/apiRequestHandler.js';
import { logger } from './common/logger.js';

const GENERATOR_PORT = getEnv("GENERATOR_PORT");

const metricStats = {
    updateMaxResponseDelayMs: (ms:number) => mt.updateMaxApiResponseDelayMs(ms),
    incrementFailedApiCallCount: () => mt.metrics?.failedApiCallCount.inc(),
    incrementUnknownApiCallCount: () => mt.metrics?.unknownApiCallCount.inc()
};

export class GenApiServer extends EventEmitter {
    private server: Server;
    handleStart(req: IncomingMessage, res: ServerResponse) : boolean {
        return handleRequest('/' + startUrl, req, res, async (data?: string) => {
            const parsedData = JSON.parse(data!);
            const params = GenParametersValidator.parse(parsedData);
            this.emit('start', params);
            res.writeHead(200);
            res.end();
        }, metricStats);
    }
    handleStop(req: IncomingMessage, res: ServerResponse): boolean {
        return handleRequest('/' + stopUrl, req, res, async () => {
            this.emit('stop');
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
    constructor(private progressReporter: () => ProgressReport, private getStat: () => Promise<string>) {
        super()
        this.server = createServer(async (req, res) => {
            logger.info(`RECEIVING SOME REQUEST ${req.url}`)
            mt.metrics?.apiCallCount.inc();  
            if (this.handleStart(req, res)) return;
            if (this.handleStop(req, res)) return;
            if (this.handleGetProgress(req, res)) return;
            if (this.handleGetStat(req, res)) return;
            res.writeHead(404);
            res.end('Not Found');
            mt.metrics?.unknownApiCallCount.inc();
        });
        this.server.listen(GENERATOR_PORT, () => {
            logger.info(`Server listening on port ${GENERATOR_PORT}`);
        })
    }
}
