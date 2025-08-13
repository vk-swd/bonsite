import express from "express";
import { createHandler } from "graphql-http/lib/use/express";
import { buildSchema, GraphQLAbstractType, GraphQLError, GraphQLResolveInfo, GraphQLSchema, GraphQLUnionType } from "graphql";
import { GenerationState, GenParameters, ProgressReport, ProgressReportValidator, progressUrl, RequestResult, RequestResultValidator, startUrl, stoptUrl } from "./common/generator_parameters.js";
import { getEnv } from "./common/utils.js";
import { logger } from "./common/logger.js";
import { GenParametersValidator, RequestStatus } from "./common/generator_parameters.js";
import * as mtx from "./monitoring_local.js";
import { ZodObject, ZodRawShape, ZodType } from "zod";
 

const schema: GraphQLSchema = buildSchema(`
type Query {
  startGen(params: GenParameters!): Result
  stopGen: Result
  getProgress: ReProg!
  hello:String
}
union ReProg = ProgressReport | Result
type ProgressReport {
  ${Object.keys(ProgressReportValidator.shape).map(key => `  ${key}: Int`).join(",\n")}
}
type Result {
  ${Object.keys(RequestResultValidator.shape).map((key, idx) => `${key}: ${idx == 0 ? "Int!" : "String"}`).join(",\n")}
}
input GenParameters {
  ${Object.keys(GenParametersValidator.shape).map(key => `  ${key}: Int!`).join(",\n")}
}
`);

const getProgress: GraphQLUnionType = schema.getType("ReProg")! as GraphQLUnionType;
getProgress!.resolveType = (value: any) => {
    // console.log("Resolving type for:", JSON.stringify(obj));
    console.log("Resolving type for:");
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
const GRAPH_QL_PORT = getEnv("GRAPH_QL_PORT");

function toggleGeneration(params?: GenParameters): Promise<RequestResult> {
  const isStart = params !== undefined;
  const operation = "Generation " + isStart ? "start" : "stop";
  const url = `http://${GENERATOR_HOST}:${GENERATOR_PORT}/${isStart ? startUrl : stoptUrl}`;
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
function getRequest<T>(url: string, validator: ZodType<T>): Promise<T> {
  logger.info(`Fetching progress report from ${url}`);
  return fetch(url)
    .then(res => res.json())
    .then(data => {
      const result: T = Object(validator.parse(data));
      mtx.metrics?.requestSuccess.inc();
      return result;
    })
    .catch(e => {
      const msg = `Error fetching progress report: ${e}`;
      logger.error(msg);
      mtx.metrics?.requestError.inc();
      return {} as T;
    });
}
const Query = {
  hello: () => "Hello world!",
  stopGen() {
    return toggleGeneration();
  },
  startGen: async (arg: {params: GenParameters} ): Promise<RequestResult>  => {
    return toggleGeneration(arg.params);
  },
  getProgress: async (): Promise<RequestResult | ProgressReport> => {
    const res = await getRequest(`http://${GENERATOR_HOST}:${GENERATOR_PORT}/${progressUrl}`, ProgressReportValidator);
    logger.info(`Fetching progress report ${JSON.stringify(res)}`);
    return res;
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







