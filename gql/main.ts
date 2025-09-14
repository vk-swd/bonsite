import express from "express";
import { createHandler } from "graphql-http/lib/use/express";
import { buildSchema, GraphQLError, GraphQLSchema, GraphQLUnionType } from "graphql";
import * as gp from "./common/generator_parameters.js";
import { getEnv } from "./common/utils.js";
import { logger } from "./common/logger.js";
import { GenParametersValidator, RequestStatus } from "./common/generator_parameters.js";
import * as mtx from "./monitoring_local.js";
import z, { ZodObject, ZodRawShape, ZodType } from "zod";
import { HealthCheckSever } from "./common/healthcheck.js";
import { StatementParameters, reqUsersUrl, StatementParametersValidator, UserDataList, UserDataValidator, UserDataValidatorList, reqStatementUrl } from "./common/event_types.js";
import * as gqld from "./common/gqlDeclarations.js";

const schema: GraphQLSchema = buildSchema(`
type Query {
  ${gqld.startGen.declaration()}
  ${gqld.getGeneratorStats.declaration()}
  ${gqld.stopGen.declaration()}
  ${gqld.getProgress.declaration()}
  ${gqld.getStatement.declaration()}
  ${gqld.hello.declaration()}
  ${gqld.users.declaration()}
  ${gqld.postTransaction.declaration()}
}
${gqld.ProgressReportGqlType.declaration()}
${gqld.GenParametersGqlType.declaration()}
${gqld.StatementParametersGqlType.declaration()}
${gqld.PostTransactionParamsGqlType.declaration()}
${gqld.UserRecordGqlType.declaration()}
`);

const GENERATOR_PORT = getEnv("GENERATOR_PORT");
const GENERATOR_HOST = getEnv("GENERATOR_HOST");
const STATEMENT_GENERATOR_PORT = getEnv("STATEMENT_GENERATOR_PORT");
const STATEMENT_GENERATOR_HOST = getEnv("STATEMENT_GENERATOR_HOST");
const httpG = `http://${GENERATOR_HOST}:${GENERATOR_PORT}/`;
const httpSG = `http://${STATEMENT_GENERATOR_HOST}:${STATEMENT_GENERATOR_PORT}/`;
const GRAPH_QL_PORT = getEnv("GRAPH_QL_PORT");

function params<T>(params: T): RequestInit {
  const init = {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(params)};
  return init;
}
async function defaultDataHandler(res: Response): Promise<string> {
    return "ok";
}
function zodParse<T>(data: string | Object, validator: ZodType<T>): T {
  try {
    return validator.parse(data);
  } catch (e) {
    throw new Error(`Zod validation failed for ${JSON.stringify(data)}: ${e}`);
  }
}
function getRequest<T>(url: string, dataHandler: (data: Response) => Promise<T>, init?: RequestInit): Promise<T> {
  const now = Date.now();
  mtx.metrics?.requestCount.inc();
  return fetch(url, init)
    .then(res => {
      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }
      return dataHandler(res)
    })
    .then(data => {
      mtx.metrics?.requestSuccess.inc();
      return data;
    })
    .catch(error => {
      const msg = `Error fetching ${url}: ${error}`;
      logger.error(msg);
      mtx.metrics?.requestError.inc();
      throw new Error(msg);
    }).finally(() => {
        const delay = Date.now() - now;
        mtx.updateMaxApiResponseDelayMs(delay);
    })
}
const Query = {
  hello: () => {throw new Error("Hello world!")},
  stopGen: () => {
    return getRequest<string>(httpG + gp.stopUrl, defaultDataHandler);
  },
  startGen: async (arg: {params: gp.GenParameters} ) => {
    return getRequest<string>(httpG + gp.startUrl, defaultDataHandler, params(arg.params));
  },
  getProgress: async (): Promise<gp.ProgressReport> => {
      return await getRequest(httpG + gp.progressUrl, async (res: Response) => 
        zodParse(await res.json(), gp.ProgressReportValidator));
  },
  getGeneratorStats: async (): Promise<string> => {
      return await getRequest<string>(httpG + gp.getStatUrl, res => res.text());
  },
  getStatement: async (arg: {params: StatementParameters} ): Promise<string> => {
    return await getRequest(httpSG + reqStatementUrl, res => res.text(), params(arg.params));
  },
  users: async (arg: {name?: string} ): Promise<UserDataList> => {
    return await getRequest<UserDataList>(httpSG + reqUsersUrl, async (res: Response) => {
      const data = UserDataValidatorList.parse(await res.json());
      // logger.info(`Fetched users: ${JSON.stringify(data)}`);
      return data as UserDataList;
    }, params(arg.name));
  } 
}
try {
  await mtx.startMonitoring();

  const app = express();
  app.all(
    "/graphql",
    createHandler({
      schema,
      rootValue: Query
    })
  );
  app.listen(GRAPH_QL_PORT, () => {
    logger.info(`Running a GraphQL API server at http://localhost:${GRAPH_QL_PORT}/graphql`);
  });
} catch (e) {
  const msg = `Error starting GraphQL server: ${JSON.stringify(e)}`;
  logger.error(msg);
  mtx.metrics?.serverSetUpFailed.inc();
  await mtx.dumpRegistry();
  throw new GraphQLError(msg);
}


const healthCheckServer = new HealthCheckSever();





