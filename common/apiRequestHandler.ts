
import { IncomingMessage, ServerResponse } from 'http';
import { logger } from './logger.js';

export type MetricStats = {
    updateMaxResponseDelayMs: (value: number) => void,
    incrementFailedApiCallCount: () => void,
    incrementUnknownApiCallCount: () => void
}
export function handleRequest<T>(url: string, req: IncomingMessage, res: ServerResponse, 
    process: (data?: string) => Promise<T>, metrics: MetricStats): boolean {
    if (url != req.url) {
        return false;
    }
    const now = Date.now();
    if (req.method === 'POST') {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => {
            process(data).then((_) => {
                metrics.updateMaxResponseDelayMs(Date.now() - now);
            }).catch((error) => {
                logger.error(`Error processing request for ${req.url}: ${error}`);
                metrics.incrementFailedApiCallCount();
                res.writeHead(400, `Request processing error for ${req.url}: ${error.message.replace(/[^\x20-\x7E]+/g, '')}`);
                res.end();
            });
        });
    } else if (req.method === 'GET'){
        process().then((_) => {
            metrics.updateMaxResponseDelayMs(Date.now() - now);
        }).catch((error) => {
            logger.error(`Error processing request for ${req.url}: ${error}`);
            metrics.incrementFailedApiCallCount();
            res.writeHead(500, `Request processing error for ${req.url}: ${error.message.replace(/[^\x20-\x7E]+/g, '')}`);
            res.end();
        });
    } else {
        metrics.incrementUnknownApiCallCount();
        res.writeHead(404, `Unsupported method: ${req.method}`);
        res.end();
    }
    return true;
}
