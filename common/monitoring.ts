
import * as prom from 'prom-client'
import { Server, createServer } from 'http';
import { logger } from './logger.js';
import { getEnv } from './utils.js';

const PORT = getEnv("MONITORING_PORT");



export class MonitoringServer {
    private server: Server;
    constructor(scrape: () => void = () => {}) {
        this.server = createServer(async (req, res) => {
            if (req.url === '/metrics') {
                res.setHeader('Content-Type', prom.register.contentType);
                scrape();
                res.writeHead(200);
                res.end(await prom.register.metrics());     
            }
        });
        this.server.listen(PORT, () => {
            logger.log(`Listening on http://localhost:${PORT}, metrics on /metrics`);
        });
    }
    updateMetrics() {
        // This method can be used to update metrics if needed
        // For example, you can call prom.register.metrics() to get the current metrics
        logger.log("Metrics updated");
    }
}



// const cnt1 = new prom.Counter({name: "testCounter", help: "beresh i countish"});