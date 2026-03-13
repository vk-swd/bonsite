
# GraphQL Server

The server provides API for a Web application to create transaction and get back statements and state reports.

The [API](../architecture/APIs) section shows, among other things, the place of Graph QL Server in the system and which calls it makes where.

The [Types and Schemas](../architecture/TypesAndSchemas) section shows, among other things, the approach used for schema definition - it is the textual schema generation using types defined in common/generator_parameters.ts and common/event_types.ts and helper functions for generation of the schema elements in common/gqlDeclarations.ts.

Schema is defined in gql/schema.ts