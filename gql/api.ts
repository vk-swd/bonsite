import express from "express";
import { createHandler } from "graphql-http/lib/use/express";
import { Query, schema } from "./schema.js";
import { Deferred, sleep } from "./common/utils.js";
import { LoginData, LoginDataValidator } from "./common/event_types.js";
import { logger } from "./common/logger.js";
import { ApiError, ApiErrorType, customHeaderParamClientId } from "./common/gqlDeclarations.js";

type GqlServerConfig = {
    port: number,
    url: string,
    generatorAddress: string,
    statementGeneratorAddr: string
}

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
    assignCookie(res: express.Response): void {
        res.cookie(SESSION_COOKIE, this.value, { httpOnly: true, secure: true });
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
export class GqlServer {
    clients = new Map<string, ClientState>();
    inFlightLoginAttempts = 0;
    authMiddleware(req: express.Request, res: express.Response, next: any): void {
        const clientId = req.headers[customHeaderParamClientId] as string;
        if (!clientId) {
            res.status(400).json(new ApiError(`Missing client ID header`, ApiErrorType.NOT_AUTHENTICATED));
            res.end();
            return;
        }
        let client = this.clients.get(clientId);
        if (!client) {
            client = new ClientState();
            this.clients.set(clientId, client);
        }

        const sessionId: string | undefined = req.headers.cookie?.split(";").filter(
            (item) => item.trim().startsWith(SESSION_COOKIE + "="))[0]?.split("=")[1];
        // const sessionId = req.cookies?.sessionId;
        let dropReason = "";
        if (!sessionId || !client.token) {
            dropReason = "Not authorized";
        } else if (client.token.value !== sessionId) {
            dropReason = "Wrong credentials";
        } else if (client.token.isValid() !== true) {
            dropReason = "Session expired";
        }
        if (dropReason.length > 0) {
            logger.log(`Dropping request from ${clientId}. Reason: ${dropReason}`);
            res.status(401).json(new ApiError(dropReason, ApiErrorType.NOT_AUTHENTICATED));
            res.end();
            return;
        }
        client.token!.touchedAt = Date.now();
        next();
    }
    handleLogin(req: express.Request, res: express.Response) {
        if (this.inFlightLoginAttempts > 5) {
            res.status(429).json({ error: 'Many concurrent log ins. Wait.' });
            res.end();
            return;
        }
        this.inFlightLoginAttempts++;
        const clientId: string = req.headers[customHeaderParamClientId] as string;
        if (!clientId) {
            res.status(400).json({ error: `Missing client ID header ${customHeaderParamClientId}` });
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
            client.token.assignCookie(res);
            this.inFlightLoginAttempts--;
            return res.status(200);
        }
        logger.log("Login attempt", clientId, req.body);
        const params: LoginData = LoginDataValidator.parse(req.body);
        //wait for authorisation items
        logger.log("Login attempt1", clientId, params);
        sleep(800 + Math.random() * 5000).then(() => {
            if (params.user !== LOGIN || params.password !== PASSWORD) {
                res.status(401).json({ error: 'Invalid credentials' });
                res.end();
                this.clients.delete(clientId)
                return;
            }
            logger.log("Login success", clientId);
            client.token = new Token();
            client.token.assignCookie(res);
            res.status(200);
            res.end();
        }).catch((e) => {
            logger.log("Login error", e);
            res.status(400).json({ error: `Login error: ${e}` })
            res.end();
            this.clients.delete(clientId)
        })
        .finally(() => {
            this.inFlightLoginAttempts--;
        });
    }
    static create(config: GqlServerConfig): Promise<GqlServer> {
        const deferred = new Deferred<GqlServer>();
        const app = express();
        const gqlServer = new GqlServer(app);
        app.post('/login', express.json(), gqlServer.handleLogin.bind(gqlServer));
        app.all(
            config.url,
            gqlServer.authMiddleware.bind(gqlServer),
            createHandler({
                schema,
                rootValue: Query(config.generatorAddress, config.statementGeneratorAddr)
            })
        );
        app.listen(config.port, () => {
            deferred.resolve(gqlServer);
        });
        return deferred.promise;
    }
    cleanupInterval = setInterval(() => {
        this.cleanupSessions();
    }, 60 * 1000); // 1 mins
    private constructor(public app: express.Express) {

    }
    cleanupSessions(): void {
        const now = Date.now();
        for (const [sessionId, client] of this.clients) {
            if (now - client.token!.touchedAt > 30 * 60 * 1000) { // 30 mins
                this.clients.delete(sessionId);
            }
        }
    }
}

