



The following services are monitored: [Graph QL Server](./GQL), [Statement Generator](./StatementGenerator.md), [Transaction Generator](./TransactionGenerator.md), [Authentication Server](./AuthServer.md) and [Message Sink](./MessageSink.md)


A monitoring server and a common functions are defined in the monitoring.ts file and each service has its own set of metrics defined in a monitoring_local.ts file. So there are 5 files like that.

The server is invoked for every service listed with the set of metrics provided in monitoring_local.ts.