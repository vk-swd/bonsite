---
sidebar_position: 1
---


This is an application made to explore GraphQL, Kafka and SQL Server.
It consists of services described in  [Services](./services/index.md) and it's goal is to build a functional pipeline where events are posted  to a shared message queue and then stored persistently:

<div id="fig-over-1" style={{scrollMarginTop: '80px'}}></div>
<figure>
```mermaid
sequenceDiagram
    participant user as User (Web)
    participant gql as GraphQL Server
    participant K as Kafka
    participant S as SQL

    user ->> gql : post
    gql ->>  K: log / produce
    K ->> S: poll / consume, store
```
<figcaption>Figure 1: Store data</figcaption>
</figure>

Stored data can later be accessed on request:

<div id="fig-over-2" style={{scrollMarginTop: '80px'}}></div>
<figure>
```mermaid
sequenceDiagram
    participant user as User (Web)
    participant gql as GraphQL Server
    participant S as SQL
    user ->> gql: get
    gql ->> S: query
    S ->> gql: return
    gql ->> user: present
```

<figcaption>Figure 2: Get data</figcaption>
</figure>

To make things interactive and leverage GraphQL, it was designed as a web application.








