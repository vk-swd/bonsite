import { buildSchema, GraphQLSchema } from "graphql";
import * as gqld from "../common/gqlDeclarations.js";
import { MetricStats } from "../common/apiRequestHandler.js";

import * as mtx from "./monitoring_local.js";
import * as gp from "../common/generator_parameters.js";
import { StatementParameters, reqUsersUrl, postTransactionsUrl, reqStatementUrl, UserDataResult, UserDataRequestParameters, UserDataRequestValidator, UserDataValidator, UserDataResultValidator, StatementParametersValidator, StatementType, serverStateUrl, ServerState, ServerStateValidator, TransactionValidator, StatementRequestResultValidator, StatementRequestResult, UserDateRange, userDateRange } from "../common/event_types.js";
import { logger } from "../common/logger.js";

/*  ===============================================
    ALL NUMBER VALUES ARE REPLACED WITH STRINGS
    TO AVOID 64-BIT INTEGER PROBLEMS IN GRAPHQL
    blunt but simple and good enough for demo purposes
    ===============================================
    THE REPLACEMENT HAPPENS IN "getTypeName" FOR SCHEMA
    AND GqlIfy FOR PARAMETERS AND RETURN VALUES
    ===============================================
*/

export const schema: GraphQLSchema = buildSchema(`
type Query {
  ${gqld.startGen.declaration()}
  ${gqld.getGeneratorStats.declaration()}
  ${gqld.stopGen.declaration()}
  ${gqld.getProgress.declaration()}
  ${gqld.getStatement.declaration()}
  ${gqld.hello.declaration()}
  ${gqld.users.declaration()}
  ${gqld.postTransaction.declaration()}
  ${gqld.getDatabaseStats.declaration()}
  ${gqld.getTransactionDatesForUser.declaration()}
}
input ${gqld.getTypeDeclaration(gqld.startGen.paramType! as any)}
input ${gqld.getTypeDeclaration(gqld.postTransaction.paramType! as any)}
type  ${gqld.getTypeDeclaration(gqld.getProgress.returnType as any)}
type  ${gqld.getTypeDeclaration(gqld.UserDataNamedZod)}
type  ${gqld.getTypeDeclaration(gqld.users.returnType as any)}
input ${gqld.getTypeDeclaration(gqld.users.paramType! as any)}
type  ${gqld.getTypeDeclaration(gqld.getDatabaseStats.returnType as any)}
type  ${gqld.getTypeDeclaration(gqld.TransactionNamedZod)}
input ${gqld.getTypeDeclaration(gqld.getStatement.paramType! as any)}
type  ${gqld.getTypeDeclaration(gqld.getStatement.returnType as any)}
input ${gqld.getTypeDeclaration(gqld.getTransactionDatesForUser.paramType! as any)}
type  ${gqld.getTypeDeclaration(gqld.getTransactionDatesForUser.returnType as any)}
`);


const monitoring: MetricStats = {
    incrementApiCallCount: () => mtx.metrics?.requestCount.inc(),
    incrementUnknownApiCallCount: () => {},
    incrementFailedApiCallCount: () => mtx.metrics?.requestError.inc(),
    updateMaxResponseDelayMs: (delay: number) => mtx.metrics?.maxResponseDelayMs.set(delay)
};
export const defaulResponse = "ok";

function params<T>(params: T): RequestInit {
    const init = {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(params)};
    return init;
  }
  async function defaultDataHandler(res: Response): Promise<string> {
      return defaulResponse;
  }
  function getRequest<T>(url: string, dataHandler: (data: Response) => Promise<T>, monitoring: MetricStats,
  init?: RequestInit): Promise<T> {
    const now = Date.now();
    monitoring.incrementApiCallCount();
    return fetch(url, init)
      .then(res => {
        if (!res.ok) {
          throw new Error(`HTTP error! status: ${res.status}, message: ${res.statusText}`);
        }
        return dataHandler(res)
      })
      .then(data => {
        mtx.metrics?.requestSuccess.inc();
        return data;
      })
      .catch(error => {
        const msg = `Error fetching ${url}: ${error}`;
        monitoring.incrementFailedApiCallCount();
        throw new Error(msg);
      }).finally(() => {
          const delay = Date.now() - now;
          monitoring.updateMaxResponseDelayMs(delay);
      })
  }
let lastQuery = "";

class GenerationState {
  isInProgress = false;
  lastReport: gp.ProgressReport | undefined = undefined;
  lastReportTime: number = 0;
  scheduledUpdate: NodeJS.Timeout | undefined = undefined;
  subscriberCount = 0;
  awaitedProgressRequest: Promise<gp.ProgressReport> | undefined = undefined
}
const genState = new GenerationState();
class DatabaseState {

}

// to limit: post transaction / 
// requests per user should be limited for 10 per minute...or actually...one per 10 seconds
// or it could be incremental...1 per second, then next + 1 etc....adn then there are max number of requests in flight
// and then i need to pace those one from another for multiple users...transaction posting should be stored in queue
// and then this queue should be dequeued gradually.....
// can return number of posted transactions as a post result
export const Query = (generatorAddress: string, statementGeneratorAddr: string) => ({
  hello: () => {
    return lastQuery
  },
  stopGen: () => {
    if (!genState.isInProgress) {
      return;
    }
    return getRequest<string>(generatorAddress + gp.stopUrl, res => res.text(), monitoring);
  },
  startGen: async (arg: {params: gqld.GqlIfy<gp.GenParameters>} ) => {
    logger.info("startGen called with params: %o", arg.params);
    if (genState.isInProgress) {
        throw new gqld.ApiError(`Generation in progress`, gqld.ApiErrorType.GENERATOR_BUSY)
    }
    genState.isInProgress = true;
    genState.lastReport = undefined;
    const param = gqld.startGen.coercedParamType?.parse(arg.params);
    return getRequest<string>(generatorAddress + gp.startUrl, defaultDataHandler, monitoring, params(param));
  },
  getProgress: async (): Promise<gp.ProgressReport> => {
      if (genState.subscriberCount > 20) {
        throw new gqld.ApiError(`Too many requests`, gqld.ApiErrorType.TOO_MANY_REQUESTS)
      }
      if (genState.awaitedProgressRequest) {
        genState.subscriberCount++;
        return genState.awaitedProgressRequest.finally(() => genState.subscriberCount--);
      }
      if (genState.lastReport && Date.now() - genState.lastReportTime < 800) {
        return genState.lastReport;
      }
      genState.subscriberCount++;
      genState.awaitedProgressRequest = getRequest(generatorAddress + gp.progressUrl, res => res.json() as Promise<gp.ProgressReport>, monitoring)
      .then(res => {
        genState.lastReport = res;
        genState.lastReportTime = Date.now();
        genState.awaitedProgressRequest = undefined;
        genState.isInProgress = (res.isRunning == gp.GenerationState.RUNNING);
        return res;
      })
      .finally(() => genState.subscriberCount--);
      return genState.awaitedProgressRequest;
  },
  getGeneratorStats: async (): Promise<string> => {
      return await getRequest<string>(generatorAddress + gp.getStatUrl, res => res.text(), monitoring);
  },
  users: async (arg: {params: gqld.GqlIfy<UserDataRequestParameters>} ): Promise<UserDataResult> => {
    const p = gqld.users.coercedParamType?.parse(arg.params);
    return await getRequest(statementGeneratorAddr + reqUsersUrl,
      res => res.json(), monitoring, params(p)) as Promise<any>;
  },
  postTransaction: async (arg: {params: gqld.GqlIfy<gp.PostTransactionParams>} ): Promise<string> => {
    const p = gqld.postTransaction.coercedParamType?.parse(arg.params);
    return await getRequest<string>(generatorAddress + postTransactionsUrl, res => res.text(), monitoring, params(p));
  },
  getDatabaseStats: async (): Promise<ServerState> => {
    return await getRequest<ServerState>(statementGeneratorAddr + serverStateUrl, res => res.json(), monitoring);
  },
  getStatement: async (arg: {params: gqld.GqlIfy<StatementParameters>} ): Promise<StatementRequestResult> => {
    const p = gqld.getStatement.coercedParamType?.parse(arg.params);
    return await getRequest(statementGeneratorAddr + reqStatementUrl, res => res.json(), monitoring, params(p));
  },
  getTransactionDatesForUser: async (arg: {params: gqld.GqlIfy<UserDateRange>} ): Promise<UserDateRange> => {
    const p = gqld.getTransactionDatesForUser.coercedParamType?.parse(arg.params);
    return await getRequest(statementGeneratorAddr + userDateRange, async res => {
      return await res.json();
    }, monitoring, params(p));
  }
})
