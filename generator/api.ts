import { createServer, Server } from 'http';
import { EventEmitter } from 'events';
import { z } from "zod";

const GenParametersValidator = z.object({
    userCount: z.number(),
    maxTransactionsPerDay: z.number(),
    generationIntervalMs: z.number()
});
export type GenParameters = z.infer<typeof GenParametersValidator>;

const GENERATOR_PORT = process.env.GENERATOR_PORT;
export class GenApiServer extends EventEmitter {
    private server: Server;
    constructor() {
        super()
        this.server = createServer(async (req, res) => {
            if (req.method === 'POST' && req.url === '/start') {
                let data = '';
                req.on('data', chunk => data += chunk);
                req.on('end', () => {
                    try {
                        const params: GenParameters = GenParametersValidator.parse(req);
                        this.emit('start', params);
                        res.writeHead(200);
                        res.end('Generation request accepted.');
                    } catch (error) {
                        res.writeHead(400);
                        res.end(`Malformed JSON: ${error}`);
                    }
                });
            } else if (req.method === 'POST' && req.url === '/stop') {
                this.emit('stop');
            } else {
                res.writeHead(404);
                res.end('Not Found');
            }
        });
        this.server.listen(GENERATOR_PORT, () => {
            console.log(`Server listening on port ${GENERATOR_PORT}`);
        })
    }
}
