import express from "express";
import { createHandler } from "graphql-http/lib/use/express";
import { buildSchema, GraphQLError, GraphQLSchema } from "graphql";
import { GenParameters, RequestResult, RequestResultValidator, startUrl, stoptUrl } from "./common/generator_parameters.js";
import { getEnv } from "./common/utils.js";
import { logger } from "./common/logger.js";
import { GenParametersValidator, RequestStatus } from "./common/generator_parameters.js";
import * as mtx from "./monitoring_local.js";
 

const schema: GraphQLSchema = buildSchema(`
type Query {
  startGen(params: GenParameters!): Result
  stopGen: Result
  hello:String
}
type Result {
  ${Object.keys(RequestResultValidator.shape).map((key, idx) => `${key}: ${idx == 0 ? "Int!" : "String"}`).join(",\n")}
}
input GenParameters {
  ${Object.keys(GenParametersValidator.shape).map(key => `  ${key}: Int!`).join(",\n")}
}
`);

const GENERATOR_PORT = getEnv("GENERATOR_PORT");
const GENERATOR_HOST = getEnv("GENERATOR_HOST");
const GRAPH_QL_PORT = getEnv("GRAPH_QL_PORT");

const Query = {
  hello: () => "Hello world!",
  stopGen() {
    logger.info(`stop gen`)
    mtx.metrics?.requestCount.inc();
    return fetch(`http://${GENERATOR_HOST}:${GENERATOR_PORT}/${stoptUrl}`, {
      method: "POST",
      headers: {
      "Content-Type": "application/json",
        Accept: "application/json",
      }
    })
    .then(re=> {
      mtx.metrics?.requestSuccess.inc();
      return { status: RequestStatus.OK, message: re.status } })
    .catch(e => {
      const msg = `stopGen WEIRD ERROR ${e}`;
      logger.error(msg);
      mtx.metrics?.requestError.inc();
      return { status: RequestStatus.ERROR, message: msg };
    });
  },
  startGen: async (arg: {params: GenParameters} ): Promise<RequestResult>  => {
    mtx.metrics?.requestCount.inc();
    logger.info(`toggleGentoggleGentoggleGentoggleGen ${JSON.stringify(arg.params)}`)
    return await fetch(`http://${GENERATOR_HOST}:${GENERATOR_PORT}/${startUrl}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(arg.params),
    })
      .then(res => res.text())
      .then(res => {
        mtx.metrics?.requestSuccess.inc();
        return { status: RequestStatus.OK, message: res } as RequestResult;
      })
      .catch(e => {
        mtx.metrics?.requestError.inc();
        const res =
        {
          status: RequestStatus.ERROR,
          message: `GOT SOME ERROR: "${e}" ON GEN PARAMS: ${JSON.stringify(arg.params)} for address ${GENERATOR_HOST}:${GENERATOR_PORT}`
        };
        logger.error(res.message);
        return res;
      });
  }
}

try {
  await mtx.startMonitoring();

  const app = express();
  app.all(
    "/graphql",
    createHandler({
      schema,
      rootValue: Query,
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







