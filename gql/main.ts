import express from "express";
import { createHandler } from "graphql-http/lib/use/express";
import { GraphQLResolveInfo }from "graphql/type"
import { buildSchema, GraphQLObjectType, GraphQLSchema, GraphQLSchemaConfig } from "graphql";
 
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
}
type Face {
  name: String!,
  color: String,
  hairLength: Int!,
  piercing: Piercing,
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
  }
}
// The root provides a resolver function for each API endpoint
const root = {
  // hello() {
  //   return "Hello world!";
  // },
  Query
};
 

const app = express();
 
// Create and use the GraphQL handler
app.all(
  "/graphql",
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








