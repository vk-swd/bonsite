# SQL Database Service



## Overview

Microsoft SQL Server database stores transaction data in the following tables:
1. Transactions - all transaction requests regardless of whether they were allowed, which is described by "transaction results" messages.
2. Transaction results - to select which transactions to be posted in the statements and to keep track record of all the attempts for analytics.
3. User data - user id and names.
4. Raw records - a Dead Letter Queue - style tables (transactions_raw and transaction_results_raw) for inconsistent records. Currently the only inconsistency checked is duplicate transaction ids. Storing detected inconsistencies is important for debugging and recovery.
5. Offsets - this table holds kafka consumer offsets. This data is moved into the database to simplify the offset tracking and use the SQL Transactions to ensure that database writes and Kafka offset updates are atomic.
6. Stats - for a simple performance measurements of bulk write procedures.

## Indexing

1. Transaction and results records don't have a foreign key for "Id" column because the transaction and results records live in different topics and there is no guarantee that one record will be consumed before hte other. Also enforcing this check is not critical here because it would be validated anyway during a statement preparation.
2. Non-clustered indexes were provided to speed up data lookup by dates and transaction results.


## Notes

1. The database layout could be optimized further to suit specific look up patterns, like storing confirmed and unconfirmed transactions in different data tables or even databases.
2. Database replication and/or partitioning - exploring ways to scale database and make it more reliable in a distributed environment or design a topology that would allow fast parallel operation was not in the scope of this project.
3. Bulk writes in a temporary table are made for an optimal use of connection bandwidth and to make transactions faster. Data is then transferred using stored procedures.
4. Rows are rotated in a way that is unacceptable in real world but I had to save resources so that application can run more autonomously. That is why following measures were taken:
    1. A SIMPLE recovery mode was set to make faster flushes of the transaction log file at the expense of its backup.
    2. The CHECKPOINT call, triggering the flush, is done after every transaction. 
    3. Data rotation is performed when the database size crosses a threshold. The rotation is done as the removal of the oldest records.
    4. To make removals faster and avoid inflated transaction logs the removal task is split into smaller chunks.

