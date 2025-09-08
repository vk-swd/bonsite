import express from "express";
import { createHandler } from "graphql-http/lib/use/express";
import { buildSchema, GraphQLAbstractType, GraphQLError, GraphQLResolveInfo, GraphQLSchema, GraphQLUnionType } from "graphql";
import * as gp from "./common/generator_parameters.js";
import { getEnv } from "./common/utils.js";
import { logger } from "./common/logger.js";
import { GenParametersValidator, RequestStatus } from "./common/generator_parameters.js";
import * as mtx from "./monitoring_local.js";
import z, { ZodObject, ZodRawShape, ZodType } from "zod";
import { HealthCheckSever } from "./common/healthcheck.js";
import { StatementParameters, StatementParametersValidator, reqStatementUrl } from "./common/event_types.js";
 

const schema: GraphQLSchema = buildSchema(`
type Query {
  startGen(params: GenParameters!): Result
  stopGen: Result
  getProgress: ReProg!
  getGeneratorStats: Result!
  getStatement(params: StatementParameters!): Result
  hello:String
}
union ReProg = ProgressReport | Result
type ProgressReport {
  ${Object.keys(gp.ProgressReportValidator.shape).map(key => `  ${key}: Int`).join(",\n")}
}
type Result {
  ${Object.keys(gp.RequestResultValidator.shape).map((key, idx) => `${key}: ${idx == 0 ? "Int!" : "String"}`).join(",\n")}
}
input GenParameters {
  ${Object.keys(GenParametersValidator.shape).map(key => `${key}: Int`).join(",\n")}
}
input StatementParameters {
  ${Object.keys(StatementParametersValidator.shape).map(key => `${key}: Int`).join(",\n")}
}
`);

const getProgress: GraphQLUnionType = schema.getType("ReProg")! as GraphQLUnionType;
getProgress!.resolveType = (value: any) => {
    console.log("Resolving type for:", JSON.stringify(value));
    if (value.status !== undefined) {
      return "Result";
    }
    if (value.totalSent !== undefined) {
      return "ProgressReport";
    }
    return Promise.resolve(undefined);
}

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
function toggleGeneration(params?: gp.GenParameters): Promise<gp.RequestResult> {
  const isStart = params !== undefined;
  const operation = "Generation " + isStart ? "start" : "stop";
  const url = `http://${GENERATOR_HOST}:${GENERATOR_PORT}/${isStart ? gp.startUrl : gp.stopUrl}`;
  logger.info(operation + isStart ? ` with params: ${JSON.stringify(params)}` : "");
  mtx.metrics?.requestCount.inc();
  return fetch(url, {
    method: "POST",
    headers: {
    "Content-Type": "application/json",
      Accept: "application/json",
    },
    ...(isStart ? { body: JSON.stringify(params) } : {})
  })
  .then(res => res.text())
  .then(message=> {
    mtx.metrics?.requestSuccess.inc();
    return { status: RequestStatus.OK, message } })
  .catch(e => {
    const msg = `${operation} ERROR: ${e}`;
    logger.error(msg);
    mtx.metrics?.requestError.inc();
    return { status: RequestStatus.ERROR, message: msg };
  });
}
async function defaultDataHandler(res: Response): Promise<any> {
    const raw = await res.json()
    return zodParse(raw, gp.RequestResultValidator);
}
function zodParse<T>(data: string | Object, validator: ZodType<T>): T {
  try {
    return validator.parse(data);
  } catch (e) {
    throw new Error(`Zod validation failed for ${JSON.stringify(data)}: ${e}`);
  }
}
function getRequest<T>(url: string, dataHandler: (data: Response) => Promise<T> = defaultDataHandler, init?: RequestInit): Promise<T|gp.RequestResult> {
  console.log(`Fetching ${url} with init: ${JSON.stringify(init)}`);
  const now = Date.now();
  return fetch(url, init)
    .then(res => {
      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }
      console.log(`Request to ${url} successful, status: ${JSON.stringify(res)}`);
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
      return { status: RequestStatus.ERROR, message: msg };
    }).finally(() => {
        const delay = Date.now() - now;
        mtx.updateMaxApiResponseDelayMs(delay);
    })
}
const Query = {
  hello: () => "Hello world!",
  stopGen() {
    return toggleGeneration();
  },
  startGen: async (arg: {params: gp.GenParameters} ): Promise<gp.RequestResult>  => {
    return toggleGeneration(arg.params);
  },
  getProgress: async (): Promise<gp.RequestResult | gp.ProgressReport> => {
      return await getRequest(httpG + gp.progressUrl, async (res: Response) => 
        zodParse(await res.json(), gp.ProgressReportValidator));
  },
  getGeneratorStats: async (): Promise<gp.RequestResult> => {
      return await getRequest(httpG + gp.getStatUrl)
  },
  getStatement: async (arg: {params: StatementParameters} ): Promise<gp.RequestResult> => {
    return await getRequest(httpSG + reqStatementUrl, async (res: Response) => {
      return { status: RequestStatus.OK, message:"", data: await res.text() }}, params(arg.params));
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
    console.log(`Running a GraphQL API server at http://localhost:${GRAPH_QL_PORT}/graphql`);
  });
} catch (e) {
  const msg = `Error starting GraphQL server: ${JSON.stringify(e)}`;
  logger.error(msg);
  mtx.metrics?.serverSetUpFailed.inc();
  await mtx.dumpRegistry();
  throw new GraphQLError(msg);
}


const healthCheckServer = new HealthCheckSever();





