import express from "express";
import { ApiError, ApiErrorType, customHeaderParamClientId } from "./common/gqlDeclarations.js";
import { logger } from "./common/logger.js";
import { LoginData, LoginDataValidator } from "./common/event_types.js";
import { sleep } from "./common/utils.js";




const PASSWORD = "sup#rS3cr3tB@nana========"
const LOGIN = "user1"
const SESSION_COOKIE = "sessionId"
let counter = 0;
class Token {
    static LIFETIME_MS = 30 * 60 * 1000; // 10 mins
    value: string;
    createdAt: number;
    touchedAt: number;
    constructor(private lifeTimeMs: number = Token.LIFETIME_MS) {
        this.value = Math.random().toString(36).substring(2) + (counter++);
        this.createdAt = Date.now();
        this.touchedAt = this.createdAt;
    }
    assignCookie(res: express.Response, clientId: string): void {
        res.cookie(SESSION_COOKIE, this.value, { httpOnly: true, secure: true });
        res.cookie(customHeaderParamClientId, clientId, { httpOnly: true, secure: true });
    }
    isValid(): boolean {
        return (Date.now() - this.touchedAt) < this.lifeTimeMs; // 10 mins
    }
}

class ClientState {
    userId: string = "";
    createdAt: number = Date.now();
    authorisedAt: number | undefined = undefined;
    token: Token | undefined = undefined;
}

export class AuthServer {
    clients = new Map<string, ClientState>();
    inFlightLoginAttempts = 0;
    handleAuth(req: express.Request, res: express.Response): void {
        logger.log("Auth attempt", req.headers);
        const clientIdCookie: string | undefined = req.headers.cookie?.split(";").filter(
            (item) => item.trim().startsWith(customHeaderParamClientId + "="))[0]?.split("=")[1];
        if (!clientIdCookie) {
            logger.log(`Dropping request. Reason: Missing client ID header`);
            res.status(401).json(new ApiError(`Missing client ID header`, ApiErrorType.NOT_AUTHENTICATED));
            res.end();
            return;
        }
        const client = this.clients.get(clientIdCookie);
        const sessionId: string | undefined = req.headers.cookie?.split(";").filter(
            (item) => item.trim().startsWith(SESSION_COOKIE + "="))[0]?.split("=")[1];
        // const sessionId = req.cookies?.sessionId;
        let dropReason = "";
        if (!sessionId || !client?.token) {
            dropReason = "Not authorized";
        } else if (client.token.value !== sessionId) {
            dropReason = "Wrong credentials";
        } else if (client.token.isValid() !== true) {
            dropReason = "Session expired";
        }
        if (dropReason.length > 0) {
            logger.log(`Dropping request from ${clientIdCookie}. Reason: ${dropReason}`);
            res.status(401).json(new ApiError(dropReason, ApiErrorType.NOT_AUTHENTICATED));
            res.end();
            return;
        }
        client!.token!.touchedAt = Date.now();
        res.status(200);
        res.end();
    }
    handleLogin(req: express.Request, res: express.Response) {
        logger.log("handleLogin", req.headers);
        if (this.inFlightLoginAttempts > 5) {
            res.status(429).json({ error: 'Many concurrent log ins. Wait.' });
            res.end();
            return;
        }
        this.inFlightLoginAttempts++;
        const clientId: string = req.headers[customHeaderParamClientId] as string;
        if (!clientId) {
            res.status(401).json({ error: `Missing client ID header ${customHeaderParamClientId}` });
            res.end();
            this.inFlightLoginAttempts--;
            return;
        }
        let client = this.clients.get(clientId);
        if (!client) {
            client = new ClientState();
            this.clients.set(clientId, client);
        }
        if (client.token && client.token.isValid()) {
            this.inFlightLoginAttempts--;
            return res.status(200);
        }
        const params: LoginData = LoginDataValidator.parse(req.body);
        //wait for authorisation items
        sleep(800 + Math.random() * 1000).then(() => {
            if (params.user !== LOGIN || params.password !== PASSWORD) {
                res.status(401).json({ error: 'Invalid credentials' });
                res.end();
                // TODO: Rate limit individual
                return;
            }
            logger.log("Login success", clientId);
            client.token = new Token();
            client.token.assignCookie(res, clientId);
            res.status(200);
            res.end();
        }).catch((e) => {
            logger.log("Login error", e);
            res.status(400).json({ error: `Login error: ${e}` })
            res.end();
            // TODO: Rate limit individual
        })
        .finally(() => {
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
            if (now - client.createdAt > toTime && client.token && client.token.touchedAt > toTime) { // 30 mins
                this.clients.delete(sessionId);
            }
        }
    }
}

