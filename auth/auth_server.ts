import express from "express";
import { ApiError, ApiErrorType, customHeaderParamClientId } from "../common/gqlDeclarations.js";
import { logger } from "../common/logger.js";
import { LoginData, LoginDataValidator } from "../common/event_types.js";
import { getEnv, sleep } from "../common/utils.js";
import { metrics } from "./monitoring_local.js";

import {OAuth2Client} from 'google-auth-library'
import session from "express-session";
import { log } from "console";
import {RedisStore} from "connect-redis"
import {createClient, RedisClientType} from "redis"

import rateLimit from 'express-rate-limit';


// const session = require("express-session")

const COLUDFLARE_AUTH_SECRET = getEnv("CLOUDFLARE_SECRET")
const PASSWORD = "sup#rS3cr3tB@nana========"
const PASSWORD1 = "genericPublicPassword"
const LOGIN = "user1"
const LOGIN1 = "user"
const SESSION_COOKIE = "sessionId"
const CONNECTIONG_IP_C = "cf-connecting-ip"
const ORIGINAL_URI = "x-original-uri"
let counter = 0;

// Google OAuth configuration
const GOOGLE_CLIENT_ID = getEnv("GOOGLE_CLIENT_ID");
const GOOGLE_CLIENT_SECRET = getEnv("GOOGLE_CLIENT_SECRET");

declare module 'express-session' {
    /* Extending Session data sturcture with Declaration merging.
        https://github.com/DefinitelyTyped/DefinitelyTyped/blob/c879e14427560c32a5dc0d462a860ad8cdb303a8/types/express-session/index.d.ts#L14
     */
    interface Session {
        state: string,
        tokenInfo: Object,
        passInfo: string
    }
}

class LoginState {
    createdAt: number = Date.now();
    loggingIn: boolean = false;
}


async function validateCFWithRetry(token: string, remoteip: string, 
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
                .then(_ => validateCFWithRetry(token, remoteip, idempotencyKey, attempt + 1, maxRetries))
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
    clients = new Map<string, LoginState>();
    inFlightLoginAttempts = 0;
    // Store OAuth state to link back to clientId
    oauthStates = new Map<string, { clientId: string; createdAt: number }>();
    noCLientIdIps = new LoggedIps("No client id IPs");
    wrongCredentialIps = new LoggedIps("WrongCredential IPs");
    notAuthorisedIps = new LoggedIps("Not authorised IPs");
    rateLimitedIps = new LoggedIps("Rate limited IPs");
    wrongPasswordsIps = new LoggedIps("Wrong password IPs");
    successLoginIps = new LoggedIps("Successful login IPs");
    loggerTimer = setInterval(() => {
        this.noCLientIdIps.logAndClear()
        this.wrongCredentialIps.logAndClear()
        this.notAuthorisedIps.logAndClear()
        this.rateLimitedIps.logAndClear()
        this.wrongPasswordsIps.logAndClear()
        this.successLoginIps.logAndClear()
    }, 1000);
    failAuth(res: express.Response, info: string, reason: string) {
        logger.info(info, ":", reason);
        res.status(401).json(new ApiError(reason, ApiErrorType.NOT_AUTHENTICATED));
        res.end();
        return true;
    }
    sessions = new Set<string>();
    handleGoogleAuth(req: express.Request, res: express.Response): void {
        // //wait for authorisation items
        const oAuth2Client = new OAuth2Client({
            clientId: GOOGLE_CLIENT_ID,
            clientSecret: GOOGLE_CLIENT_SECRET,
            redirectUri: 'https://bonsite.org/authggl'
        });
        req.session.state = crypto.randomUUID();
        const authorizeUrl = oAuth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: ['https://www.googleapis.com/auth/userinfo.profile', 'https://www.googleapis.com/auth/userinfo.email'],
            prompt: 'consent select_account',
            state: req.session.state
        });
        logger.info("sid on g1", req.sessionID)
        // res.redirect(authorizeUrl)
        res.status(200).json({urii: authorizeUrl});
        res.end();
    }
    handleAuthGgl(req: express.Request, res: express.Response): void {
        const myUrl = new URL(req.url, 'http://bonsite.org');
        const code: string = myUrl.searchParams.get('code')??"dolbocode";    // "XYZ123"
        const state = myUrl.searchParams.get('state');  // "abc"

        if (!state || state != req.session.state) {
            this.failAuth(res, "handleAuthGgl", `different states: ${state} vs ${req.session.state}`)
            return;
        }
        // //wait for authorisation items
        const oAuth2Client = new OAuth2Client({
            clientId: GOOGLE_CLIENT_ID,
            clientSecret: GOOGLE_CLIENT_SECRET,
            redirectUri: 'https://bonsite.org/authggl'
        });

        // Make sure to set the credentials on the OAuth2 client.
        oAuth2Client.getToken(code)
        .then(r => {
            logger.log("2", r, (r as any).tokens.access_token)
            return oAuth2Client.getTokenInfo(
                (r as any).tokens.access_token
              ).then(tokenInfo => {
                    req.session.tokenInfo = tokenInfo;
                    logger.log("tokenInfo", tokenInfo)
                    res.redirect("/doc.html")
                    res.status(200);
                })
        })
        .catch(e => {
            res.redirect("/doc.html") //check auth and redirect to login if need be
            res.status(200);
            logger.error("error", e)
        })
        .finally(() => {
            logger.info("WIP test");
            res.end();
        })
        // res.cookie("mycooke", new Date().toISOString())
    }
    handleSession(req: express.Request, res: express.Response): void {
        // TODO: remember why I used this to for redirection and not just return login.html from nginx config
        logger.info("resp cookies ", res.get("Set-Cookie"), "req cookies", req.headers.cookie);
        logger.info("handleSession", req.headers.cookie, req.sessionID);
        res.status(200);
        res.redirect("/login.html");
        res.end();
    }
    handleAuth(req: express.Request, res: express.Response): void {
        metrics?.authRequests.inc();
        const cookies = cookieMap(req.headers.cookie??"");
        const from = req.headers[CONNECTIONG_IP_C]
        const origUrl = req.headers[ORIGINAL_URI];
        const clientId: string | undefined = req.headers[customHeaderParamClientId] as string ??cookies[customHeaderParamClientId]
        const info = `${from}:${clientId}->${origUrl}`
        logger.info("Auth info", info, req.session, req.sessionID, req.session.tokenInfo, req.session.passInfo);
        if (!req.session || (!req.session.tokenInfo && !req.session.passInfo)) {
            this.failAuth(res, info, `Unauthenticated guys. recorded as no client id.`);
            metrics?.noClientIdCount.inc();
            this.noCLientIdIps.logIp(info);
            res.status(403);
            res.end();
            return
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
            client = new LoginState();
            this.clients.set(clientId!, client);
        } else if (client.loggingIn) {
            res.status(429).json(new ApiError(`Already verifying. Wait.`, ApiErrorType.RATE_LIMITED));
            res.end();
            this.inFlightLoginAttempts--;
            return;
        }
        client.loggingIn = true;
        const params: LoginData = LoginDataValidator.parse(req.body);
        sleep(800 + Math.random() * 1000).then(() => {
            if ((params.user !== LOGIN && params.user !== LOGIN1) 
                || (params.password !== PASSWORD && params.password != PASSWORD1) 
                || !params.metadata || params.metadata.length == 0) {
                metrics?.wrongPasswords.inc();
                this.wrongPasswordsIps.logIp(info);
                res.status(401).json({ error: 'Invalid credentials' });
                res.end();
                return;
            }
            return validateCFWithRetry(params.metadata, from, crypto.randomUUID(),0, 3).then(cfRes => {
                // TODO: count time to update tunstile
                if (cfRes.success !== true) {
                    metrics?.cfTokenRejectionCount.inc();
                    res.status(401).json({ error: 'Invalid credentials' });
                    res.end();
                } else {
                    this.successLoginIps.logIp(info);
                    logger.info("sf results", cfRes);
                    req.session.passInfo = "passed";
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
            client.loggingIn = false;
            this.inFlightLoginAttempts--;
        });
    }
    cleanupInterval = setInterval(() => {
        this.cleanupSessions();
    }, 60 * 1000); // 1 mins
    app: express.Express
    sessionMid: any
    redisClient: any
    constructor(port: number) {
        this.app = express();
        const redisClient = createClient({socket: { host: "redis", port: 6379 }})
        this.redisClient = redisClient;
        redisClient.connect()
        .then(res => {
            logger.info("Connected to Redis", res);
            this.app.set('trust proxy',1) //do i need it? it works without it.
            this.app.use((req: express.Request, res: express.Response, next: any) => {
                logger.debug("getting request", JSON.stringify(req.session), JSON.stringify(req.headers), req.url)
                next();
            })
             
            const limiter = rateLimit({
                windowMs: 10 * 1000, // 10 seconds
                max: 20,
                keyGenerator: req => req.headers[customHeaderParamClientId] as string ?? "unknown_client",
                handler: (req, res) => {
                    metrics?.rateLimitedCount.inc();
                    this.rateLimitedIps.logIp(`${req.headers[CONNECTIONG_IP_C]}:${req.headers[customHeaderParamClientId]}->${req.url}`);
                    res.status(429).json({ error: 'Too many requests' });
                }
            });
            this.app.use(limiter);
            const rs = new RedisStore({
                client: this.redisClient,
                prefix: "app:",
            })
            rs.client.set("testkey", "testvalue").then(() => {
                logger.info("Redis store is working");
            }).catch((e: any) => {
                logger.error("Redis store error", e);
            })
            this.sessionMid = session({
                secret: "your environment variable could be here", // TODO: add ENV VAR
                rolling: true,
                cookie: {
                    maxAge: 600000, // 10 mins
                    secure: false, // TODO: add ENV VAR for to turn it on for https.
                    httpOnly: true
                },
                genid: req => {
                    const id =  crypto.randomUUID(); // must be unique & unpredictable
                    logger.info("generating session id", id, "for req session ", JSON.stringify(req.session), "current store ", this.sessionMid)
                    return id;
                },
                store: rs,
                resave: false,
                saveUninitialized: true
            })
            this.app.use(this.sessionMid)
            this.app.post('/login', express.json(), this.handleLogin.bind(this));
            this.app.get('/session', express.json(), this.handleSession.bind(this));
            this.app.get('/auth', express.json(), this.handleAuth.bind(this));
            this.app.get('/googleAuth', express.json(), this.handleGoogleAuth.bind(this));
            this.app.get('/authggl', express.json(), this.handleAuthGgl.bind(this));
            this.app.listen(port, () => {
                logger.info(`Auth server started at http://localhost:${port}`);
            });
        })
        .catch((err) => logger.error("Redis connection error", err));
    }
    cleanupSessions(): void {
        const now = Date.now();
        for (const [sessionId, client] of this.clients) {
            const toTime = 30 * 60 * 1000
            if ((now - client.createdAt) > toTime) { // 30 mins
                this.clients.delete(sessionId);
            }
        }
    }
}

