import { createServer, Server } from 'http';
import { EventEmitter } from 'events';
import { GenParameters, GenParametersValidator, ProgressReport, progressUrl, startUrl, stoptUrl as stopUrl } from './common/generator_parameters.js';
import { getEnv } from './common/utils.js';
import * as mt from './monitoring_local.js'

const GENERATOR_PORT = getEnv("GENERATOR_PORT");
export class GenApiServer extends EventEmitter {
    private server: Server;
    constructor(progressReporter: () => ProgressReport) {
        super()
        this.server = createServer(async (req, res) => {
            console.log(`RECEIVING SOME REQUEST ${req.url}`)
            mt.metrics?.apiCallCount.inc();
            if (req.method === 'POST') { 
                if (req.url === '/' + startUrl) {
                    let data = '';
                    req.on('data', chunk => data += chunk);
                    req.on('end', () => {
                        console.log(`RECEIVING SOME REQUEST data ${data}`)
                        try {
                            const ddd: GenParameters = JSON.parse(data)
                            console.log(`parsing data ${ddd.maxTransactionsPerSec}`);
                            const params: GenParameters = GenParametersValidator.parse(JSON.parse(data) as GenParameters);
                            console.log(`Received parameters: ${JSON.stringify(params)}`);
                            this.emit('start', params);
                            res.writeHead(200);
                            res.end();
                        } catch (error) {
                            mt.metrics?.failedApiCallCount.inc();
                            res.writeHead(400);
                            res.end(`Malformed JSON: ${error}`);
                        }
                    });
                } else if (req.url === '/' + stopUrl) {
                    this.emit('stop');
                    res.writeHead(200);
                    res.end();
                } else {
                    mt.metrics?.failedApiCallCount.inc();
                    res.writeHead(404);
                    res.end('Not Found');
                }
            } else if (req.method === 'GET') {
                if (req.url === '/' + progressUrl) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(progressReporter()));
                } else {
                    mt.metrics?.failedApiCallCount.inc();
                    res.writeHead(404);
                    res.end('Not Found');
                }
            } else {
                mt.metrics?.failedApiCallCount.inc();
                res.writeHead(404);
                res.end('Not Found');
            }
        });
        this.server.listen(GENERATOR_PORT, () => {
            console.log(`Server listening on port ${GENERATOR_PORT}`);
        })
    }
}
