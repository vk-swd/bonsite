import { getEnv } from "../common/utils.js";
import { logger } from "../common/logger.js";
import * as mtx from "./monitoring_local.js";
import { HealthCheckSever } from "../common/healthcheck.js";
import { GqlServer } from "./api.js";
import { coreReg } from "../common/monitoring.js";


const httpG = `http://${getEnv("GQL_GENERATOR_HOST_NAME")}:${getEnv("GQL_GENERATOR_PORT")}/`;
const httpSG = `http://${getEnv("GQL_STATEMENT_GENERATOR_HOST_NAME")}:${getEnv("GQL_STATEMENT_GENERATOR_PORT")}/`;
const GQL_PORT = getEnv("GQL_PORT");



try {
  await mtx.startMonitoring();
  const app = await GqlServer.create({
      port: Number.parseInt(GQL_PORT),
      url: "/graphql",
      generatorAddress: httpG,
      statementGeneratorAddr: httpSG
  });
  logger.info(`Running a GraphQL API server at http://localhost:${GQL_PORT}/graphql`);
} catch (e) {
  const msg = `Error starting GraphQL server: ${JSON.stringify(e)}`;
  logger.error(msg);
  mtx.metrics?.serverSetUpFailed.inc();
  await mtx.dumpRegistry(coreReg);
  await mtx.dumpRegistry(mtx.localReg);
  throw new Error(msg);
}


const healthCheckServer = new HealthCheckSever();





