


# Message Sink Service


To start consuming Kafka messages, the last consumed offset per topic-partition is read from the database.
Offsets are stored in the database to synchronize writing of data to SQL and saving of Kafka offsets. All is performed as a single atomic transaction, and if it fails, the batch will attempt another write. 
TODO: a potential bug - the batch is removed from the buffer regardless of whether the database write succeeds, so it is possible that if the next batch is written, the previous will be lost. Previous tests didn't show this issue, so will need to make new test to confirm the issue and the fix.

The Kafka consumption is buffered, to have a room for handling database write errors.

"processWhilePaused" - a call that recursively queues itself into the NodeJS event queue with Promise.then.catch.finally upon completion. 

It is not a recursive call.

It gradually empties all the buffered messages that were consumed from Kafka.

As messages are consumed they are forwarded to the database with a "processBatch" callback.
"processConsumedBatch" is provided as "processBatch" when the consumer subscribes to Kafka in "connectToKafka".

The "processConsumedBatch" function writes consumed batches and their Kafka offset to the database. The order of offsets within consumed partition is guaranteed by Kafka.


```mermaid
sequenceDiagram
    participant K as Kafka
    participant KC as KafkaConnection
    participant S as Sink (startup)
    participant DB as SQL Server

    Note over S,DB: Startup
    S->>DB: getOffsets()<br/>SELECT from scm.kafka_offsets
    DB-->>S: Map<groupId+topic+partition → offset>

    S->>KC: connectToKafka(getOffset, processBatch)
    KC->>K: consumer.connect()
    KC->>K: consumer.subscribe([transactions, transaction_results])
    KC->>K: consumer.run()

    K-->>KC: consumer.group_join event<br/>(partition assignments)

    loop for each assigned topic/partition
        KC->>K: consumer.seek(topic, partition, savedOffset)<br/>only if offset != "0"
    end

    KC-->>S: resolve KafkaConnection (Deferred)
    Note over S: healthcheck → healthy ✓

    Note over K,DB: Consume → Write loop (runs indefinitely)

    loop indefinitely
        K-->>KC: eachBatch callback<br/>(topic, partition, messages[])

        alt consumer not yet paused
            KC->>K: consumer.pause(allJoinedTopics)
            Note over KC: paused = true
        end

        KC->>KC: pauseBuffer.push(batch)
        Note over KC: batches may keep arriving into pauseBuffer<br/>before the pause takes effect in Kafka

        Note over KC,DB: processWhilePaused — drains buffer recursively

        loop while pauseBuffer not empty
            KC->>KC: batch = pauseBuffer.shift()

            alt messages parse OK (Zod MetadataWrapperValidator)
                KC->>DB: BEGIN TRANSACTION
                KC->>DB: CREATE #tempTable
                KC->>DB: bulk INSERT messages → #tempTable
                KC->>DB: EXEC CommitRecorded...<br/>(dedup, auto-insert unknown users,<br/>merge #temp → live table)
                KC->>DB: EXEC addKafkaOffset<br/>(UPSERT groupId+topic+partition → lastOffset)
                KC->>DB: COMMIT
                DB-->>KC: { newCount, duds }
            else parse failed
                KC->>DB: INSERT raw messages → scm.raw_data
                KC->>DB: EXEC rotateTables (if size threshold exceeded)
            end

            KC->>K: batch.resolveOffset(lastOffset)<br/>(kafkajs heartbeat / offset bookkeeping)
        end

        KC->>K: consumer.resume(allJoinedTopics)
        Note over KC: paused = false — ready for next batch
    end
```
