
import { IncomingMessage, ServerResponse } from 'http';

type MetricStats = {
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
            process(data).then(() => {
                res.writeHead(200);
                res.end();
                metrics.updateMaxResponseDelayMs(Date.now() - now);
            }).catch((error) => {
                metrics.incrementFailedApiCallCount();
                res.writeHead(400);
                res.end(`Request processing error for ${req.url}: ${error}`);
            });
        });
    } else if (req.method === 'GET'){
        process().then((r) => {
            const contentType = typeof r === 'string' ? 'text/plain' : 'application/json';
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(JSON.stringify(r));
            metrics.updateMaxResponseDelayMs(Date.now() - now);
        }).catch((error) => {
            metrics.incrementFailedApiCallCount();
            res.writeHead(500);
            res.end(`Request processing error for ${req.url}: ${error}`);
        });
    } else {
        metrics.incrementUnknownApiCallCount();
        res.writeHead(404);
        res.end('Malformed request');
    }
    return true;
}
