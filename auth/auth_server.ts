import express from "express";
import { ApiError, ApiErrorType, customHeaderParamClientId } from "./common/gqlDeclarations.js";
import { logger } from "./common/logger.js";
import { LoginData, LoginDataValidator } from "./common/event_types.js";
import { getEnv, sleep } from "./common/utils.js";
import { metrics } from "./monitoring_local.js";


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
    isExpired: boolean = false;
    constructor(private lifeTimeMs: number = Token.LIFETIME_MS) {
        this.value = Math.random().toString(36).substring(2) + (counter++);
        this.createdAt = Date.now();
    }
    assignCookie(res: express.Response, clientId: string, info: string): void {
        logger.debug("Assigning cookie", this.value, info);
        res.cookie(SESSION_COOKIE, this.value, { httpOnly: true, secure: true });
        res.cookie(customHeaderParamClientId, clientId, { httpOnly: true, secure: true });
    }
    checkExpiredAndReportIsValid(): boolean {
        if (this.isExpired) {
            return false;
        }
        const isExpired = (Date.now() - this.createdAt) >= this.lifeTimeMs;
        if (isExpired) {
            this.isExpired = true;
            metrics?.usersExpired.inc();
        }
        return !isExpired; // 10 mins
    }
}

class ClientState {
    userId: string = "";
    createdAt: number = Date.now();
    authorisedAt: number | undefined = undefined;
    token: Token | undefined = undefined;
    verifying: boolean = false;
    lastRequestTime: number = 0;
    assignToken(token: Token, res: express.Response, clientId: string, info: string) {
        if (this.token && !this.token.isExpired) {
            metrics?.usersExpired.inc();
        }
        this.token = token;
        this.token.isExpired = false;
        this.token.assignCookie(res, clientId, info);
        metrics?.usersAuthorised.inc();
    }
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
class LoggedIps {
    private ipMap = new Map<string, number>();
    constructor(private label: string) {}
    count = 0;
    logIp(ip: string) {
        const count = this.ipMap.get(ip);
        this.count++;
        if (count !== undefined) {
            this.ipMap.set(ip, count + 1);
        } else {
            this.ipMap.set(ip, 1);
        }
    }
    logAndClear() {
        const size = this.ipMap.size;
        if (this.ipMap.size > 0) {
            const entries = Array.from(this.ipMap.entries());
            if (entries.length > 30) {
                entries.sort((a, b) => b[1] - a[1]).splice(30);
            }
            this.ipMap.clear();
            logger.info(this.label, ". Visitor count: ", size, ", attempts:", this.count, ", ips:", entries);
            this.count = 0;
        }
    }
}
export class AuthServer {
    clients = new Map<string, ClientState>();
    inFlightLoginAttempts = 0;
    noCLientIdIps = new LoggedIps("No client id IPs");
    wrongCredentialIps = new LoggedIps("WrongCredential IPs");
    notAuthorisedIps = new LoggedIps("Not authorised IPs");
    rateLimitedIps = new LoggedIps("Rate limited IPs");
    wrongPasswordsIps = new LoggedIps("Wrong password IPs");
    successLoginIps = new LoggedIps("Successful login IPs");
    loggerTimer = setInterval(() => {
        this.rateLimitedIps.logAndClear();
        this.wrongPasswordsIps.logAndClear();
        this.successLoginIps.logAndClear();
    }, 1000);
    limitRate(client: ClientState) {
        client.lastRequestTime = Date.now();
    }
    checkRateLimit(client: ClientState, res: express.Response): boolean {
        const now = Date.now();
        const elapsed = now - client.lastRequestTime
        if (elapsed < 1000) {
            res.status(400).json(new ApiError(`Try in ${1000 - elapsed} ms`, ApiErrorType.RATE_LIMITED));
            res.end();
            return true;
        }
        return false;
    }
    failAuth(res: express.Response, info: string, reason: string) {
        logger.debug(info, ":", reason);
        res.status(401).json(new ApiError(reason, ApiErrorType.NOT_AUTHENTICATED));
        res.end();
        return true;
    }
    handleAuth(req: express.Request, res: express.Response): void {
        metrics?.authRequests.inc();
        const cookies = cookieMap(req.headers.cookie??"");
        const from = req.headers[CONNECTIONG_IP_C]
        const origUrl = req.headers[ORIGINAL_URI];
        const clientId: string | undefined = req.headers[customHeaderParamClientId] as string ??cookies[customHeaderParamClientId]
        const info = `${from}:${clientId}->${origUrl}`
        logger.debug(info + " auth");
        if ((!clientId || clientId.length == 0)) {
            this.failAuth(res, info, `Missing client ID header`);
            metrics?.noClientIdCount.inc();
            this.noCLientIdIps.logIp(info);
            return;
        }
        const client = this.clients.get(clientId!);
        if (!client) {
            this.failAuth(res, info, `Unauthorised client`);
            return;
        }
        if (this.checkRateLimit(client, res)) {
            metrics?.rateLimitedCount.inc();
            this.rateLimitedIps.logIp(info);
            return;
        }
        const sessionId: string | undefined = cookies[SESSION_COOKIE]
        let dropReason = "";
        if (!sessionId || !client.token) {
            dropReason = "Not authorized";
            this.notAuthorisedIps.logIp(info);
        } else if (client.token.value !== sessionId) {
            dropReason = "Wrong credentials";
            this.wrongCredentialIps.logIp(info);
        } else if (client.token.checkExpiredAndReportIsValid() !== true) {
            dropReason = "Session expired";
        }
        if (dropReason.length > 0) {
            this.limitRate(client);
            this.failAuth(res, info, dropReason);
            logger.debug(info, ":", dropReason);
            return;
        }
        metrics?.authorisedActions.inc();
        logger.debug(info, `success`);
        res.status(200);
        res.end();
    }
    handleLogin(req: express.Request, res: express.Response) {
        metrics?.loginRequests.inc();
        const from = req.headers[CONNECTIONG_IP_C] as string
        const origUrl = req.headers[ORIGINAL_URI];
        const clientId: string | undefined = req.headers[customHeaderParamClientId] as string
        const info = `${from}:${clientId}->${origUrl}`
        logger.debug(info);
        if (this.inFlightLoginAttempts > 5) {
            metrics?.rateLimitedCount.inc();
            this.rateLimitedIps.logIp(info);
            res.status(429).json(new ApiError(`Many concurrent log ins. Wait.`, ApiErrorType.RATE_LIMITED));
            res.end();
            return;
        }
        this.inFlightLoginAttempts++;

        if ((!clientId || clientId.length == 0)) {
            this.failAuth(res, info, `Missing client ID header`);
            metrics?.noClientIdCount.inc();
            this.noCLientIdIps.logIp(info);
            this.inFlightLoginAttempts--;
            return;
        }
        let client = this.clients.get(clientId!);
        if (!client) {
            client = new ClientState();
            this.clients.set(clientId!, client);
        } else if (this.checkRateLimit(client, res)) {
            metrics?.rateLimitedCount.inc();
            this.rateLimitedIps.logIp(info);
            this.inFlightLoginAttempts--;
            return;
        }
        if (client.token && client.token.checkExpiredAndReportIsValid()) {
            this.inFlightLoginAttempts--;
            metrics?.authorisedActions.inc();
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
                metrics?.wrongPasswords.inc();
                this.wrongPasswordsIps.logIp(info);
                res.status(401).json({ error: 'Invalid credentials' });
                res.end();
                this.limitRate(client!);
                return;
            }
            return validateWithRetry(params.metadata, from, crypto.randomUUID(),0, 3).then(cfRes => {
                // TODO: count time to update tunstile
                if (cfRes.success !== true) {
                    metrics?.cfTokenRejectionCount.inc();
                    res.status(401).json({ error: 'Invalid credentials' });
                    res.end();
                } else {
                    this.successLoginIps.logIp(info);
                    client.assignToken(new Token(), res, clientId!, info);
                    res.status(200);
                    res.end();
                }
            })
        }).catch((e) => {
            logger.debug("Login error", e);
            metrics?.loginAsyncErrors.inc();
            res.status(400).json({ error: `Login error: ${e}` })
            res.end();
            // TODO: Rate limit individual?
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
            const tokenExpired = client.token?.checkExpiredAndReportIsValid() ?? true;
            if (((now - client.createdAt) > toTime) && tokenExpired) { // 30 mins
                this.clients.delete(sessionId);
            }
        }
    }
}

