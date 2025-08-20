import { createServer, Server } from 'http';
import { EventEmitter } from 'events';
import { GenParameters, GenParametersValidator, ProgressReport, progressUrl, startUrl, getStatUrl, stopUrl, RequestStatus } from './common/generator_parameters.js';
import { getEnv } from './common/utils.js';
import * as mt from './monitoring_local.js'
import { RequestResult } from './common/generator_parameters.js';

const GENERATOR_PORT = getEnv("GENERATOR_PORT");
export class GenApiServer extends EventEmitter {
    private server: Server;
    constructor(progressReporter: () => ProgressReport, getStat: () => Promise<string>) {
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
                            const parsedData = JSON.parse(data);
                            console.log(`RECEIVING SOME REQUEST parsedData ${JSON.stringify(parsedData)}`)
                            const params = GenParametersValidator.parse(parsedData);
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
                } else if (req.url === '/' + getStatUrl) {
                    getStat().then(stat => {
                        const r: RequestResult = {
                            status: RequestStatus.OK,
                            message: '',
                            data: stat
                        };
                        res.writeHead(200, { 'Content-Type': 'text/plain' });
                        res.end(JSON.stringify(r));
                    }).catch(err => {
                        mt.metrics?.failedApiCallCount.inc();
                        res.writeHead(500);
                        res.end(`Error generating stat: ${err}`);
                    });
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
