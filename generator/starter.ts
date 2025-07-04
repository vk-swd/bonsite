import { createServer, IncomingMessage, ServerResponse } from 'http';

type GenParameters = {
    userCount: number;
    maxTransactionsPerDay: number;
};

let generatorRunning = false;
let currentParams: GenParameters | null = null;
let interval: NodeJS.Timeout | null = null;

function startGeneration(params: GenParameters, res: ServerResponse) {
    if (generatorRunning) {
        res.writeHead(400);
        return res.end('Generator already running.');
    }

    generatorRunning = true;
    currentParams = params;

    console.log('Starting generation with:', params);
    interval = setInterval(() => {
        console.log(`Simulating with ${params.userCount} users, ${params.maxTransactionsPerDay} tx/day`);
    }, 2000);

    res.writeHead(200);
    res.end('Generation started.');
}

function stopGeneration(res: ServerResponse) {
    if (!generatorRunning) {
        res.writeHead(400);
        return res.end('Generator is not running.');
    }

    generatorRunning = false;
    currentParams = null;

    if (interval) {
        clearInterval(interval);
        interval = null;
    }

    console.log('Generation stopped.');

    res.writeHead(200);
    res.end('Generation stopped.');
}

function parseBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => {
            try {
                resolve(JSON.parse(data));
            } catch (err) {
                reject(err);
            }
        });
    });
}

const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/start') {
        try {
            const body = await parseBody(req);
            if (
                typeof body.userCount !== 'number' ||
                typeof body.maxTransactionsPerDay !== 'number'
            ) {
                res.writeHead(400);
                return res.end('Invalid parameters.');
            }

            startGeneration(body, res);
        } catch {
            res.writeHead(400);
            res.end('Malformed JSON.');
        }
    } else if (req.method === 'POST' && req.url === '/stop') {
        stopGeneration(res);
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

server.listen(3000, () => {
    console.log('Server listening on port 3000');
});
