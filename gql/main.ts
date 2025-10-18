import { getEnv } from "./common/utils.js";
import { logger } from "./common/logger.js";
import * as mtx from "./monitoring_local.js";
import { HealthCheckSever } from "./common/healthcheck.js";
import { GqlServer } from "./api.js";
import { coreReg } from "./common/monitoring.js";


const GENERATOR_PORT = getEnv("GENERATOR_PORT");
const GENERATOR_HOST = getEnv("GENERATOR_HOST");
const STATEMENT_GENERATOR_PORT = getEnv("STATEMENT_GENERATOR_PORT");
const STATEMENT_GENERATOR_HOST = getEnv("STATEMENT_GENERATOR_HOST");
const httpG = `http://${GENERATOR_HOST}:${GENERATOR_PORT}/`;
const httpSG = `http://${STATEMENT_GENERATOR_HOST}:${STATEMENT_GENERATOR_PORT}/`;
const GRAPH_QL_PORT = getEnv("GRAPH_QL_PORT");



try {
  await mtx.startMonitoring();
  const app = await GqlServer.create({
      port: Number.parseInt(GRAPH_QL_PORT),
      url: "/graphql",
      generatorAddress: httpG,
      statementGeneratorAddr: httpSG
  });
  logger.info(`Running a GraphQL API server at http://localhost:${GRAPH_QL_PORT}/graphql`);
} catch (e) {
  const msg = `Error starting GraphQL server: ${JSON.stringify(e)}`;
  logger.error(msg);
  mtx.metrics?.serverSetUpFailed.inc();
  await mtx.dumpRegistry(coreReg);
  await mtx.dumpRegistry(mtx.localReg);
  throw new Error(msg);
}


const healthCheckServer = new HealthCheckSever();





