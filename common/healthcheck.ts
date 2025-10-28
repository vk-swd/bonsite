import { createServer, Server } from 'http';
import { getEnv } from './utils.js';

const HEALTHCHECK_PORT = getEnv("HEALTHCHECK_PORT");
export class HealthCheckSever {
    private server: Server;
    constructor(public isHealthy: boolean = true) {
        this.server = createServer(async (req, res) => {
            if (req.url === '/') {
                if (this.isHealthy) {
                    res.writeHead(200, { 'Content-Type': 'text/plain' });
                    res.end('OK');
                } else {
                    res.writeHead(503, { 'Content-Type': 'text/plain' });
                    res.end('Service Unavailable');
                }
            } else {
                res.writeHead(404);
                res.end('Not Found');
            }
        });
        this.server.listen(HEALTHCHECK_PORT, () => {
            console.log(`Heathchecks are expected on port ${HEALTHCHECK_PORT}`);
        })
    }
}
