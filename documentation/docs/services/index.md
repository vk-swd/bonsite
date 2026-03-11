# Services

Below is the overview of how services interact. Feel free to click on the blocks in the diagram.
## System Overview
```mermaid
flowchart TD
    wa[Web App] --> |http request| nginx
    nginx <--> |Authorize request|auth[Auth Service]
    nginx --> |Authorized request|gql[GraphQL Server]
    gql --> |Set generation task|tg[Transaction Generator]
    gql <--> |Get statement|sgt[Statement Generator]
    tg --> |Generate transaction and store it in Kafka|kafka[(Kafka)]
    kafka ~~~ ms[Message Sink]
    ms --> |Consume transaction| kafka
    ms --> |Store transaction| db[(SQL Database)]
    db <--> |Query transactions| sgt

    
    click wa "/docs/services/WebApp" "Web App docs"
    click nginx "/docs/services/Nginx" "Nginx docs"
    click auth "/docs/services/AuthService" "Auth Service docs"
    click gql "/docs/services/GQL" "GraphQL Server docs"
    click tg "/docs/services/TransactionGenerator" "Transaction Generator docs"
    click sgt "/docs/services/StatementGenerator" "Statement Generator docs"
    click kafka "/docs/services/Kafka" "Kafka docs"
    click ms "/docs/services/MessageSink" "Message Sink docs"
    click db "/docs/services/SQLDatabase" "SQL Database docs"
```


The following diagram is unreadable without any magnification but is still informative, if someone would really want to take a look.

```mermaid
sequenceDiagram
    participant W as WebSite
    participant N as Nginx
    participant A as AuthServer
    participant Gql as GraphQL Server
    participant TG as Transaction Generator
    participant K as Kafka
    participant sink as Message Sink
    participant SC as Statement Composer
    participant sql as Microsoft SQL Server

    W->>N: Post Transaction T1 between C1 and C2
    N ->> A: check authorization
    A ->> N: success
    N ->> Gql: proxy pass T1 post request
    Gql->>TG: Generate T1
    TG->>K: Send T1 to Kafka
    K->>sink: Deliver T1
    sink-->>K: Acknowledge offset
    sink->>sql: Store T1 and save offset
    W->>Gql: Request transactions for C1
    Gql->>SC: Request transactions for C1
    SC->>sql: Query transactions for C1
    sql-->>SC: Return T1
    SC-->>Gql: Return T1
    Gql-->>W: Present T1
```



