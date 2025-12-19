# Bank Transaction System

A full-stack learning project demonstrating distributed system concepts.

🔗 **Live Demo:** https://bonsite.org  
📝 **Login:** user / genericPublicPassword

## Tech Stack
- **Backend:** Node.js, GraphQL, Apache Kafka, MS SQL Server
- **Frontend:** React
- **Infrastructure:** Docker, Oracle Cloud Infrastructure

## Architecture
Full-stack banking transaction system with event-driven write path and request-response read path. User transactions are published to Kafka and consumed asynchronously for bulk writes to MS SQL Server, while account statements are queried on-demand via GraphQL. Deployed on personal infrastructure with OCI compute instance providing VPN connectivity.

---
*Code available during technical interview*
