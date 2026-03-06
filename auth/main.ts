import { getEnv } from "../common/utils.js";
import { AuthServer } from "./auth_server.js";
import { HealthCheckSever } from "../common/healthcheck.js"
import { startMonitoring } from "./monitoring_local.js";


const port = getEnv("AUTH_PORT");
const authServer = new AuthServer(Number.parseInt(port));
const healthServer = new HealthCheckSever();
startMonitoring();