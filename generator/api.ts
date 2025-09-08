import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { EventEmitter } from 'events';
import { GenParametersValidator, ProgressReport, progressUrl, startUrl, getStatUrl, stopUrl, RequestStatus } from './common/generator_parameters.js';
import { getEnv } from './common/utils.js';
import * as mt from './monitoring_local.js'
import { handleRequest } from './common/apiRequestHandler.js';

const GENERATOR_PORT = getEnv("GENERATOR_PORT");

const metricStats = {
    updateMaxResponseDelayMs: (ms:number) => mt.updateMaxApiResponseDelayMs(ms),
    incrementFailedApiCallCount: () => mt.metrics?.failedApiCallCount.inc(),
    incrementUnknownApiCallCount: () => mt.metrics?.unknownApiCallCount.inc()
};

export class GenApiServer extends EventEmitter {
    private server: Server;
    handleStart(req: IncomingMessage, res: ServerResponse) : boolean {
        return handleRequest('/' + startUrl, req, res, (data?: string) => {
            return new Promise<void>((resolve, reject) => {
                try {
                    const parsedData = JSON.parse(data!);
                    const params = GenParametersValidator.parse(parsedData);
                    this.emit('start', params);
                    resolve();
                } catch (error) {
                    reject(`Malformed JSON: ${error}`);
                }
            });
        }, metricStats);
    }
    handleStop(req: IncomingMessage, res: ServerResponse): boolean {
        return handleRequest('/' + stopUrl, req, res, () => {
            this.emit('stop');
            return Promise.resolve();
        }, metricStats);
    }
    handleGetProgress(req: IncomingMessage, res: ServerResponse): boolean {
        return handleRequest('/' + progressUrl, req, res, () => {
            return Promise.resolve(this.progressReporter());
        }, metricStats);
    }
    handleGetStat(req: IncomingMessage, res: ServerResponse): boolean {
        return handleRequest('/' + getStatUrl, req, res, () => {
            return this.getStat().then(stat => {
                return {
                    status: RequestStatus.OK,
                    message: '',
                    data: stat
                };
            });
        }, metricStats);
    }
    constructor(private progressReporter: () => ProgressReport, private getStat: () => Promise<string>) {
        super()
        this.server = createServer(async (req, res) => {
            console.log(`RECEIVING SOME REQUEST ${req.url}`)
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
            console.log(`Server listening on port ${GENERATOR_PORT}`);
        })
    }
}
