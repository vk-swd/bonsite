import { createServer, Server } from 'http';
import { EventEmitter } from 'events';
import { getEnv } from './common/utils.js';
import { StatementParameters, StatementParametersValidator, reqStatementUrl } from './common/event_types.js';
// import * as mt from './monitoring_local.js'

const STATEMENT_GENERATOR_PORT = getEnv("STATEMENT_GENERATOR_PORT");
export class StatementGenApiServer extends EventEmitter {
    private server: Server;
    constructor(statementWriter: (p: StatementParameters) => Promise<string>) {
        super()
        this.server = createServer(async (req, res) => {
            console.log(`RECEIVING SOME REQUEST ${req.url}`)
            // mt.metrics?.apiCallCount.inc();
            if (req.method === 'POST') {
                if (req.url === '/' + reqStatementUrl) {
                    let data = '';
                    req.on('data', chunk => data += chunk);
                    req.on('end', () => {
                        const p = StatementParametersValidator.parse(JSON.parse(data))
                        statementWriter(p).then(rr => {
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(rr);
                            // mt.metrics?.successfulApiCallCount.inc();
                        }).catch(err => {
                            console.error('Error in progressReporter:', err);
                            // mt.metrics?.failedApiCallCount.inc();
                            res.writeHead(500);
                            res.end(`Internal Server Error: ${err.message}`);
                        });
                    });
                } else {
                    // mt.metrics?.failedApiCallCount.inc();
                    res.writeHead(404);
                    res.end('Not Found');
                }
            } else {
                // mt.metrics?.failedApiCallCount.inc();
                res.writeHead(404);
                res.end('Not Found');
            }
        });
        this.server.listen(STATEMENT_GENERATOR_PORT, () => {
            console.log(`Server listening on port ${STATEMENT_GENERATOR_PORT}`);
        })
    }
}
