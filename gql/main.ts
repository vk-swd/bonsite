import express from "express";
import { createHandler } from "graphql-http/lib/use/express";
import { GraphQLResolveInfo }from "graphql/type"
import { buildSchema, GraphQLError, GraphQLObjectType, GraphQLSchema, GraphQLSchemaConfig } from "graphql";
import { GenParameters, startUrl, stoptUrl } from "./common/generator_parameters.js";
import { getEnv } from "./common/utils.js";
import { logger } from "./common/logger.js";
 
// Construct a schema using GraphQL schema language
// const schema: GraphQLSchema = buildSchema(`
//   type Query {
//     hello: String
//   }
// `);
const schema: GraphQLSchema = buildSchema(`
type Query {
  hello: String
  face(id: ID): Face
  startGen(params: GenParameters!): Int
  stopGen: Int
}
type Face {
  name: String!,
  color: String,
  hairLength: Int!,
  piercing: Piercing,
}
input GenParameters {
    userCount: Int!,
    maxTransactionsPerSec: Int!,
    generationIntervalMs: Int!
}
type Piercing {
  name: String!,
  go(i: Int): Int
}
type Mutation {
  addFace(id: ID!, name: String, color: String, hairLen: Int!): Boolean
}
`);
type Face = {
  name: string,
  color: string,
  hairLength: number,
  piercing?: { name: string },
}
const faces = new Map<string, Face>();
const GENERATOR_PORT = getEnv("GENERATOR_PORT");
const GENERATOR_HOST = getEnv("GENERATOR_HOST");
const Query = {
  hello() {
    return "Hello world!";
  },
  face(arg: {id: string}) {
    console.log(`requesting face ${JSON.stringify(arg)}`);
    return faces.get(arg.id);
  },
  name() {
    "hyirsing"
  },
  addFace(arg: {id: string, name: string, color: string, hairLength: number}) {
    console.log(`add face ${JSON.stringify(arg)}`);
    if (faces.has(arg.id)) {
      return false;
    }
    const  {id,...rest} = arg;
    faces.set(arg.id, {...rest, piercing: {name: `${Math.random()}`}} as Face);
    return true;
  },
  go(i: number): number {
    return i;
  },
  stopGen() {
    logger.info(`stop gen`)
    fetch(`http://${GENERATOR_HOST}:${GENERATOR_PORT}/${stoptUrl}`, {
      method: "POST",
      headers: {
      "Content-Type": "application/json",
        Accept: "application/json",
      }
    }).then(re=>re.status)
    .catch(e => logger.info(`stopGen WEIRD ERROR ${e}`))
  },
  startGen: async (arg: {params: GenParameters} )  => {
    logger.info(`toggleGentoggleGentoggleGentoggleGen ${JSON.stringify(arg.params)}`)
    fetch(`http://${GENERATOR_HOST}:${GENERATOR_PORT}/${startUrl}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(arg.params),
    })
    .then(res => {
      // TODO: code generation for having a single souce of truth for gen parameters or
      // at least pass error back to the client somehow          
      return res.text();
    })
    .then(res => logger.info(`gql recived response to the toggel ${res}`))
    .catch(e => {
      logger.info(`GOT SOME ERROR: "${e}" ON GEN PARAMS: ${JSON.stringify(arg)} for address ${`${GENERATOR_HOST}:${GENERATOR_PORT}`}`);
    });
  }
}

const app = express();
 
app.all(
  "/graphql",
  // (req, res) => {
  //   console.log(`request received ${req.method} ${req.url}`);
  //   return 1
  // }
  createHandler({
    schema,
    rootValue: Query,
  })
);

// app.use(cors({ origin: 'http://127.0.0.1:81' }));

// Start the server at port 4000
app.listen(4000, () => {
  console.log("Running a GraphQL API server at http://localhost:4000/graphql");
});

console.log(`items size ${faces.size}`)








