


Stores transaction records to be forwarded later to [SQL Database](./SQL.md) by [Message Sink](./MessageSink.md).

Deployed as a single partition and single replica - see [Decision](./../architecture/Decisions.md) section describing the reasoning for it.

Also the log rotation is configured to keep the space usage small and take into account that there will be many writes. Also there is an assumption that [Message Sink](./MessageSink.md) will clear the stored messages fast and records shouldn't stay there for a very long time.

Configs for log rotation:
1. KAFKA_TRANSACTION_STATE_LOG_SEGMENT_BYTES and KAFKA_LOG_SEGMENT_BYTES- small for fast and more granular cleanup

2. KAFKA_LOG_LOCAL_RETENTION_BYTES - made it x10 of a segment file to make a FIFO segment deallocation flow + by the time the oldest segment is deleted all data should be consumed by the database.

3. KAFKA_LOG_RETENTION_CHECK_INTERVAL_MS - shorter to not to miss big amount of writes.


This configuration was not made with precision in mind and in theory some data might get lost if too many [writes are made](./TransactionGenerator.md) before they are processed by a [consumer](./MessageSink.md). This configuration was chosen to save resources during the project hosting.