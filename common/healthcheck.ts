import { createServer, Server } from 'http';
import { getEnv } from './utils.js';

const HEALTHCHECK_PORT = getEnv("HEALTHCHECK_PORT");
export class HealthCheckSever {
    private server: Server;
    constructor() {
        this.server = createServer(async (req, res) => {
            console.log(`Health check request received: ${req.url}`);
            if (req.url === '/') {
                res.writeHead(200);
                res.end();
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
