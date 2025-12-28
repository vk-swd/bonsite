# Bank Statement Generator
A learning project to study different storage systems.

🔗 **Live Demo:** https://bonsite.org  
📝 **Login:** user / genericPublicPassword (or with OpenID)

## Tech Stack
- **Backend:** Node.js, GraphQL, Apache Kafka, MS SQL Server
- **Frontend:** React
- **Infrastructure:** Docker, Oracle Cloud Infrastructure

## Architecture
Kafka is used for asynchronous transaction processing with bulk database writes, GraphQL for scheduling transaction generation and querying account statements, and MS SQL Server for data persistence. 
Deployed on personal infrastructure with VPN connectivity via OCI.

---
*Code available during technical interview*
