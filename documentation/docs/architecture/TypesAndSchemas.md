
# Types and Schemas

Here I will briefly discuss what data structures were used and how they helped in working with database, GraphQL server, other NodeJS services and web applications.


Since the whole project was managed in one place and basically structured as a monorep, it was possible to set up a common type system that would 
1. Provide a [common source of truth](#common-source-of-truith)
2. Help prevent errors
3. Make additions and modifications to data schemas simpler
4. Just generally make things easier (if you believe it hard enough)

## Common source of truith

A lot of data structrure in the project are interconnected. Data structures used in API requests will pretty often define how data is defined in [SQL Server](../services/SQL.md). Not to mention that.

Adding some feature, even some new field in a data structure, would require updating the same thing manually in a lot of places. This is very error prone and hard to maintain.

To prevent that the types were designed in the following way:

## Zod 
In the head of everything stay zod defined types. 

Those types are defined in generator_parameters.ts and event_types.ts. 

Those files were split originally because one was used to define types for the transaction generator, and the other (event_types.ts) was used for types stored in Kafka and SQL Server.  Really they could just as well be combined. 

And those files represent a single source of truth.

Those files are used:
    1. To validate REST APIs in statement generator, transaction. 
    2. To sanitize input in Web application
    3. To automate schema definiton for Graph QL - some metadata was written into Zod prototypes to help convert them into textual representation in schema. See common/gqlDeclarations.ts to see how Zod types are used to define GraphQL types and schemas.
    4. To automate SQL table creation and querying - special SQL related types and functions were made to generate stored procedures, table definitions and prepare queries. They are an equivalent to common/gqlDeclarations.ts:
        1. tables.ts provides types used for opject defining data tables and providing templates and helper functions like parseQueryRes for data parsing.
        2. procedures.ts provides typescript objects representing procedures stored in the database which help generate procedure calls.
        3. queries.ts provides actual queries where types and structures are cross referenced with the source files - procedure.ts and tables.ts.
        4. db_defines.ts use the (1-3) files to interact with the mssql library and communicate with the database.
