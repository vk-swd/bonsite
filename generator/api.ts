import { createServer, Server } from 'http';
import { EventEmitter } from 'events';
import { GenParameters, GenParametersValidator, startUrl, stoptUrl as stopUrl } from './common/generator_parameters.js';
import { getEnv } from './common/utils.js';

const GENERATOR_PORT = getEnv("GENERATOR_PORT");
export class GenApiServer extends EventEmitter {
    private server: Server;
    constructor() {
        super()
        this.server = createServer(async (req, res) => {
            console.log(`RECEIVING SOME REQUEST ${req.url}`)
            if (req.method === 'POST' && req.url === startUrl) {
                let data = '';
                req.on('data', chunk => data += chunk);
                req.on('end', () => {
                    console.log(`RECEIVING SOME REQUEST dtaata ${data}`)
                    try {
                        const params: GenParameters = GenParametersValidator.parse(JSON.parse(data));
                        // this.emit('start', params);
                        res.writeHead(200);
                        res.end();
                    } catch (error) {
                        res.writeHead(400);
                        res.end(`Malformed JSON: ${error}`);
                    }
                });
            } else if (req.method === 'POST' && req.url === stopUrl) {
                // this.emit('stop');
            } else {
                console.log(`RECEIVING SOME weird url ${req.url}`)
                res.writeHead(404);
                res.end('Not Found');
            }
        });
        this.server.listen(GENERATOR_PORT, () => {
            console.log(`Server listening on port ${GENERATOR_PORT}`);
        })
    }
}
