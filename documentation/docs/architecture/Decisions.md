


The overview of the system is at the [Services](../services/index.md) section.

Below is a short list of high (and not so high) level decision used for this project.

1. Why Kafka and MS SQL - I was making a project to explore tools that were frequently appearing in job descriptions.
2. Why GraphQL - same reason as for the Kafka and MS SQL but also wanted to explore a new approach to API definition, which apparently has become very common.
3. Why NodeJS - I considered exploring Java but I was more familiar with Typescript and NodeJS and decided to take it one step at a time with the tools. Besides, NodeJS is more compact, it has a convenient package management. I considered using Java to communicate with Kafka but since I was not building a Java ecosystem, I settled for NodeJS here because the intended functionality was abundantly covered by node libraries.
4. Why Docker Compose and not Kubernetes or any other orchestration tool - I postponed scaling decision and chose simpler tool for local development. The setup provided by Docker Compose can be easier extended later. Docker was chosen because I wanted to get a deeper experience in a tool I already knew + the Compose has configuration files that relatively are easy to understand.
5. Why I make Single project for multiple services and not multiple individual projects:
	a. Individual services were too small in my opinion to keep them separate
	b. Services had lots of shared code, like logging, monitoring, database handling.
6. Why not make a monolith project:
	a. Making a monolith project also seemed unreasonable because I intended to make a system of distributed stateless services to make things more robust and easy to follow or debug.
	b. It would be easier to manage system resources across services if they run as separate processes.
		1. Expanding upon that thought - the threading model of NodeJS would be a bottleneck if all the events are managed in a single application and increasing complexity in this context and with intended use case (stack demonstration in a limited environment) is unjustified.
	c. Wanted to build a microservice architecture.
7. Why banking transactions - the decision to make a GraphQL - Kafka - MS SQL application came around when I was reading a job posting for a bank. I searched for scenarios where Kafka and MS SQL could be relevant. AI suggested logging and event notifications. But you wouldn't really need a database for those, unless some way of structuring this data is used. Transactions were a simple kind of events, but not too simple at the same time. They are easy to reason about and produce reports for, so I chose them.
8. Why there are two types of events for transactions - those were made for realism and variety. To make a transaction, intuitively speaking, you would need a user to make a request. This request will be accepted or rejected. To record this outcome a second type of event was made. So there will be a transaction record and transaction result record and only accepted transactions will be used to generate bank statements.
9. What is the point of making a "transaction result" when all transactions are generated as "accepted" - originally I was planning to randomize the outcome and produce analytics based on those. This idea was shelved eventually to narrow scope since the project was becoming complex enough and it would not add much. The second type of events were not discarded though,because they made tuning of MS SQL server procedures more interesting.
10. Why would I use kafka if I just made a single topic with a single partition and single consumer and producer.
	1. To test the API and see how it works in the most trivial setup
	2. The project was supposed to be deployed on a single machine and service scaling was not planned. It means:
		1. A single instance of Kafka will be handling reads and writes. In this setup there is no point in making multiple partitions because partitions are used for:
			1. concurrency - separate partitions can be located in different brokers/machines - in this case I could speed up production by making a parallel write, but:
				1. When I have only one instance of Kafka running, there is no point in making many partitions because the writing is managed by a single file system. Of course there are ways to parallelize IO at filesystem level (allocate log files to dedicated ssds) but it is out of scope of this project. Also making a complex configuration without any kind of benchmarking does not yield much.
				2. Things will get more complicated for no obvious reason:
					a. There would need to be a layer of logic responsible for allocation of transaction records
					b. Single partition ensures order of records, but spreading transactions across partitions would make it more challenging to enforce transaction order. Delegating it to database will slow down the database. Implementing the ordering inside a service that synchronizes Kafka records with MSSQL also adds unnecessary complexity. 
			2. replication - partitions are replicated across multiple brokers - same argument about having system deployed on a single machine and about not having any benchmarking or stress testing in place.
11. Why would i make a single kafka producer and consumer - simplicity and lack of infrastructure or intention to properly load test the system. The load testing would qualify for a separate personal project which was not the goal here.
12. Why did I decide to use Zod and HTTP API for communication between services, when I also decided to use GraphQL:
	1. GraphQL solves the over-fetching and tight coupling problems at the expense of server complexity. I wouldn't make much sense to use it on backend since backend services usually share a stable network and have a more focused in their API, so there is less coupling. And regular HTTP API is simpler. But it requires type validation, hence, Zod.
	2. Zod is a well maintained, modern, lightweight enough and provides all the functionality that I needed for type generation and verification. 
	3. Zod was instrumental for automated GraphQL and SQL schema generation and querying. It also helped me catch mistakes early when I was extending or modifying schemas, data types, APIs. See [Types and Schemas](./TypesAndSchemas)
	4. Some more on that in the [Types and Schemas](./TypesAndSchemas.md) section.
13. Why didn't I make a multi user application and instead made a single page which updates single state turning the app into some kind of multiplayer:
	* Short version: because I am also hosting this site, and because the app was intended to be used by a single user, I made a shared database and requests from all clients are filtered and ordered in a single spot (API server), for simplicity.  
	* Long version - Originally I thought this project will be deployed on a local machine by whoever would try it. Then I realized that it is unlikely anyone would bother, so instead I would have to host it for actual demonstration. Deploying it would require me to host database holding data of every user. I wanted users to be able to generate at least couple millions of records to test different bank statement configurations and hosting that much data with indexing and redundancy (Kafka) seemed unnecessarily expensive, so I decided to make a shared database. In this case there is no need to make multiple accounts. There is no need to have any account at all - the login page was made just to limit access from bots and anyone uninvited and authorization was made to limit requests.
14. My rate limiting is easy to sidestep (see [Rate Limiting](../services/AuthServer.md#rate-limiting)) - I accepted this, since I was not making an actual banking app and it was for a personal hosting done through cloudflare, which has their own ddos protection. I was curious to detect and log the occasions too, if they were to happen (they didn't).
15. Ok I decided to make microservices, how did I ensure that app won't not break if some service breaks and that data does not get corrupted - there are many uncovered points of failure in every single service, and I don't claim to have thought about everything. There are some things I though about and tried addressing in a reasonably simple way to avoid any rabbit holes. Here are some things that I did or did not do:
	1. any service except databases is made stateless and restarted by docker automatically
	2. there are healthchecks in place to probe services and mark them unhealthy if something hangs
		1. An unhealthy service can theoretically still hang and to to handle this you would need another watchdog service or orchestration app like Kubernetes or probably something else DevOPS are using.
	3. When a service crashes there is an automatic docker restart policy
	4. Services are simple and designed to be stateless:
		1. Kafka consumer that relays data to MS SQL server also writes offsets as a part of the relay transaction - this helps ensure that no data gets lost and simplifies offset management.
			1. Duplicate writes to SQL database are still possible (kafka producers have retries and can generate duplicates), but they will be detected and recorded as raw unindexed data for later analysis.
		2. Transaction generator might produce transactions with the same IDs as the ones already recorded, but in that case those transactions are made to be ignored using SQL schema constraints.
			1. Transaction metadata is normally supposed to be managed by a core bookkeeping service, but for the demo this requirement was not implemented and all ids are user defined. User can decide which transaction id to use and whether he wants to fail or not.
			2. Still, to address it in some way and make things more convenient for users there is a state polling for transaction generator and for database. Though latter is not yet displayed in frontend.
		3. Statement generator just composes statements. The most he can do is to not send a statement. It can be fixed by another request.
	5. There is no external monitoring service that checks the environment where service is deployed
		1. That means a service might hang and it won't get restarted. Normally it can be fixed by external health monitoring and automatic service reallocation or failover. It was not done here.
