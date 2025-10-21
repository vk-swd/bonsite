import express from "express";
import { ApiError, ApiErrorType, customHeaderParamClientId } from "./common/gqlDeclarations.js";
import { logger } from "./common/logger.js";
import { LoginData, LoginDataValidator } from "./common/event_types.js";
import { getEnv, sleep } from "./common/utils.js";


const COLUDFLARE_AUTH_SECRET = getEnv("CLOUDFLARE_SECRET")
const PASSWORD = "sup#rS3cr3tB@nana========"
const LOGIN = "user1"
const SESSION_COOKIE = "sessionId"
const CONNECTIONG_IP_C = "cf-connecting-ip"
const ORIGINAL_URI = "x-original-uri"
let counter = 0;
class Token {
    static LIFETIME_MS = 30 * 60 * 1000; // 10 mins
    // static LIFETIME_MS = 10 * 1000; // 10 mins
    value: string;
    createdAt: number;
    constructor(private lifeTimeMs: number = Token.LIFETIME_MS) {
        this.value = Math.random().toString(36).substring(2) + (counter++);
        this.createdAt = Date.now();
    }
    assignCookie(res: express.Response, clientId: string, info: () => string): void {
        logger.log("Assigning cookie", this.value, info());
        res.cookie(SESSION_COOKIE, this.value, { httpOnly: true, secure: true });
        res.cookie(customHeaderParamClientId, clientId, { httpOnly: true, secure: true });
    }
    isValid(): boolean {
        return (Date.now() - this.createdAt) < this.lifeTimeMs; // 10 mins
    }
}

class ClientState {
    userId: string = "";
    createdAt: number = Date.now();
    authorisedAt: number | undefined = undefined;
    token: Token | undefined = undefined;
    verifying: boolean = false;
    lastRequestTime: number = 0;
}


async function validateWithRetry(token: string, remoteip: string, 
    idempotencyKey: string, attempt: number, maxRetries = 1): Promise<any> {
    //https://developers.cloudflare.com/turnstile/get-started/server-side-validation/#advanced-validation-techniques

    if (attempt < maxRetries) {
        const formData = new FormData();
        formData.append("secret", COLUDFLARE_AUTH_SECRET);
        formData.append("response", token);
        formData.append("remoteip", remoteip);
        formData.append("idempotency_key", idempotencyKey);

        return fetch(
            "https://challenges.cloudflare.com/turnstile/v0/siteverify",
            {
                method: "POST",
                body: formData,
            })
        .then((response: Response) => {
            if (response.ok) {
                return response.json()
            } else {
                return new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000))
                .then(_ => validateWithRetry(token, remoteip, idempotencyKey, attempt + 1, maxRetries))
            }
        })
    } else {
        return Promise.reject()
    }
}

function cookieMap(cookieStr: string) {
    return Object.fromEntries(cookieStr.split(";").map(item => item.trim().split("=")))
}
export class AuthServer {
    clients = new Map<string, ClientState>();
    inFlightLoginAttempts = 0;
    rateLimit(client: ClientState, req: express.Request, res: express.Response): boolean {
        const now = Date.now();
        const elapsed = now - client.lastRequestTime
        if (elapsed < 1000) {
            res.status(400).json(new ApiError(`Try in ${1000 - elapsed} ms`, ApiErrorType.RATE_LIMITED));
            res.end();
            return true;
        }
        client.lastRequestTime = now;
        return false;
    }
    checkClientId(res: express.Response, info: () => string) {
        logger.info(info(), ": Missing client ID header");
        res.status(401).json(new ApiError(`Missing client ID header`, ApiErrorType.NOT_AUTHENTICATED));
        res.end();
        return true;
    }
    handleAuth(req: express.Request, res: express.Response): void {
        const cookies = cookieMap(req.headers.cookie??"");
        const from = req.headers[CONNECTIONG_IP_C]
        const origUrl = req.headers[ORIGINAL_URI];
        const clientId: string | undefined = req.headers[customHeaderParamClientId] as string ??cookies[customHeaderParamClientId]
        const info = () => `Check auth: ${from}:${clientId}->${origUrl}` + JSON.stringify(req.headers)
        logger.info(info());
        if ((!clientId || clientId.length == 0) && this.checkClientId(res, info)) {
            return;
        }
        const client = this.clients.get(clientId!);
        if (client && this.rateLimit(client, req, res)) {
            return;
        }
        const sessionId: string | undefined = req.headers.cookie?.split(";").filter(
            (item) => item.trim().startsWith(SESSION_COOKIE + "="))[0]?.split("=")[1];
        let dropReason = "";
        if (!sessionId || !client?.token) {
            dropReason = "Not authorized";
        } else if (client.token.value !== sessionId) {
            dropReason = "Wrong credentials";
        } else if (client.token.isValid() !== true) {
            dropReason = "Session expired";
        }
        if (dropReason.length > 0) {
            logger.info(info(), ":", dropReason);
            res.status(401).json(new ApiError(dropReason, ApiErrorType.NOT_AUTHENTICATED));
            res.end();
            return;
        }
        logger.info(info(), `success`);
        res.status(200);
        res.end();
    }
    handleLogin(req: express.Request, res: express.Response) {
        const cookies = cookieMap(req.headers.cookie??"");
        const from = req.headers[CONNECTIONG_IP_C] as string
        const origUrl = req.headers[ORIGINAL_URI];
        const clientId: string | undefined = req.headers[customHeaderParamClientId] as string
        const info = () => `Login: ${from}:${clientId}->${origUrl}`
        logger.log(info());
        if (this.inFlightLoginAttempts > 5) {
            res.status(429).json(new ApiError(`Many concurrent log ins. Wait.`, ApiErrorType.RATE_LIMITED));
            res.end();
            return;
        }
        this.inFlightLoginAttempts++;

        if ((!clientId || clientId.length == 0) && !this.checkClientId(res, info)) {
            this.inFlightLoginAttempts--;
            return;
        }
        let client = this.clients.get(clientId!);
        if (!client) {
            client = new ClientState();
            this.clients.set(clientId!, client);
        }
        if (client.token && client.token.isValid()) {
            this.inFlightLoginAttempts--;
            res.status(200);
            res.end();
            return 
        }
        if (client.verifying) {
            res.status(429).json(new ApiError(`Already verifying. Wait.`, ApiErrorType.RATE_LIMITED));
            res.end();
            this.inFlightLoginAttempts--;
            return;
        }
        client.verifying = true;
        const params: LoginData = LoginDataValidator.parse(req.body);
        //wait for authorisation items
        sleep(800 + Math.random() * 1000).then(() => {
            if (params.user !== LOGIN || params.password !== PASSWORD 
                || !params.metadata || params.metadata.length == 0) {
                res.status(401).json({ error: 'Invalid credentials' });
                res.end();
                // TODO: Rate limit individual
                return;
            }
            return validateWithRetry(params.metadata, from, crypto.randomUUID(),0, 3).then(cfRes => {
                // TODO: count time to update tunstile
                if (cfRes.success !== true) {
                    res.status(401).json({ error: 'Invalid credentials' });
                    res.end();
                }
                logger.log("Login success", clientId, cfRes);
                client.token = new Token();
                client.token.assignCookie(res, clientId!, info);
                res.status(200);
                res.end();
            })
        }).catch((e) => {
            logger.log("Login error", e);
            res.status(400).json({ error: `Login error: ${e}` })
            res.end();
            // TODO: Rate limit individual
        })
        .finally(() => {
            client.verifying = false;
            this.inFlightLoginAttempts--;
        });
    }

    cleanupInterval = setInterval(() => {
        this.cleanupSessions();
    }, 60 * 1000); // 1 mins

    app: express.Express
    constructor(port: number) {
        this.app = express();
        this.app.post('/login', express.json(), this.handleLogin.bind(this));
        this.app.get('/auth', express.json(), this.handleAuth.bind(this));
        this.app.listen(port, () => {
            logger.info(`Auth server started at http://localhost:${port}`);
        });
    }
    cleanupSessions(): void {
        const now = Date.now();
        for (const [sessionId, client] of this.clients) {
            const toTime = 30 * 60 * 1000
            if (now - client.createdAt > toTime && (!client.token || client.token.createdAt > toTime)) { // 30 mins
                this.clients.delete(sessionId);
            }
        }
    }
}

