import { parse } from 'path';
import { KClient } from '../common/kafka_client.js';
import { logger } from '../common/logger.js';
import { metrics } from './monitoring_local.js';
import EventEmitter from 'events';
import * as kf from 'kafkajs';
import { OverflowingCounter } from '../common/utils.js';

// 5 million messages can be buffered in memory. Then wait for cleanup.
const MAX_UNCONSUMED_MESSAGE_COUNT = 2000000;
export class KProducer extends EventEmitter {
    public static event = {
        requestMessages: 'requestMessages',
    }
    isConnected = false;
    isStopped = false;
    inFlight = 0;
    genTaskPending = 0;
    postedPending= 0;
    producer: Promise<kf.Producer>;
    admin: Promise<kf.Admin>;
    /*  "outbox" is a simplified version of reliability guarantee
          during the delivery.
        For delivery of critical information some redundant storage
          would have to be implemented with ensuring
          "exactly once delivery" but it was avoided in this demo.
        Also using array for simplicity (could be an adjustable ring buffer).
        Can automatically batch requests using "linger" and "max_batch_size"
          parameters like Kafka does.
    */
    outbox = new Array<{ topic: string, partition: number, msg: string, now: number, genTask: boolean; }>();
    retryTimer: NodeJS.Timeout | undefined = undefined;
    totalMessageStoredInKafka = 0;
    wailtingForReport = false;
    constructor(private client: KClient, private maxInFlight: number = 1000) {
        super();
        const producer = this.client.getProducer();
        const admin = this.client.getAdmin();
        producer.on('producer.connect', () => {
            this.isConnected = true;
            metrics?.connectCount.inc();
            // TODO: test that this will be triggered every time connection was established
            // TODO: also check that the connection will be restored after a break and this will be emit
        })
        producer.on('producer.disconnect', () => {
            metrics?.disconnectCount.inc();
            this.isConnected = false;
            if (!this.isStopped) {
                metrics?.reconnectAttempts.inc();
            }
            // TODO: should i reconnect manually if the connection was broken, or the producer will attempt reconnecting?
        })
        producer.on('producer.network.request_timeout', () => {
            metrics?.networkRequestTOCount.inc();
            // TODO: should i reconnect manually if the connection was broken, or the producer will attempt reconnecting?
        })
        producer.on('producer.network.request', (data) => {
            metrics?.networkRequestCount.inc();
            // logger.debug(`Network request: ${JSON.stringify(data)}`);
            // TODO: is this something that emit when producer sends? Why?
        })
        producer.on('producer.network.request_queue_size', (data) => {
            metrics?.networkRequestCount.inc();
            // logger.debug(`Network request queue size: ${JSON.stringify(data)}`);
            // TODO: is this something that emit when producer sends? Why?
        })
        this.producer = producer.connect().then(_ => producer);
        this.admin = admin.connect().then(_ => admin);
    }
    checkAvailableCapacity(): number {
        return MAX_UNCONSUMED_MESSAGE_COUNT - this.totalMessageStoredInKafka - this.outbox.length - this.inFlight;
    }
    getGenTaskCountPending() {
        return this.genTaskPending;
    }
    getPostedPending() {
        return this.postedPending;
    }
    attemptDelivery() {
        if (!this.isConnected || this.retryTimer !== undefined || this.inFlight >= this.maxInFlight) {
            return;
        }
        /* Decided not to overcomplicate things and not to do manual batching,
              because according to documentation Kafka already does this
              + optmising without strong prompting evidence can be unreasonable.
            With high latency and message bandwidth data can be lost if the
              outbox structure is not backed up properly, but such guarantees are
              beyond the scope of this project.
        */
        const toSend = Math.min(this.outbox.length, this.maxInFlight - this.inFlight);
        const msgBuffer = new Map<string, any[]>();
        for (let i = 0; i < toSend; i++) { // limit number of attempts to send in one go
            const m = this.outbox[i];
            const key = `${m.topic}-${m.partition}`;
            if (!msgBuffer.has(key)) {
                msgBuffer.set(key, []);
            }
            const partitionedBuffer = msgBuffer.get(key)!;
            partitionedBuffer.push(m);
        }
        const buffers = Array.from(msgBuffer.values());
        while (true) {
            let total = 0;
            for (const b of buffers) {
                if (b.length == 0) {
                    continue;
                }
                const slice = b.splice(0, 20);
                total += slice.length;
                this.inFlight+= slice.length;
                this.producer.then(producer=> producer.send({
                    topic: slice[0].topic,
                    messages: slice.map(m => ({ value: m.msg, partition: m.partition })),
                })).then(_ => {
                    slice.forEach(m => {
                        if (m.genTask) {
                            this.genTaskPending--;
                        } else {
                            this.postedPending--;
                        }
                    });
                    this.totalMessageStoredInKafka += slice.length;
                    metrics?.msgSent.inc(slice.length);
                    metrics?.maxSendIntervalMs.set(Date.now() - slice[0].now);
                }).catch(e => {
                    metrics?.msgFailed.inc();
                    if (!this.isStopped) {
                        this.outbox.push(...slice);
                        this.retryDelivery();
                    }
                }).finally(() => {
                    this.inFlight-=slice.length;
                    if (!this.isStopped) {
                        this.attemptDelivery()
                    }
                });
            }
            if (total == 0) {
                break;
            }
        }
        this.outbox.splice(0, toSend);
        this.maybeCountKafkaMessages();
        if (this.outbox.length == 0) {
            this.emit(KProducer.event.requestMessages, this.maxInFlight - this.inFlight);
        }
    }
    dropKafkaRecords() {
        return this.admin.then(admin => 
                admin.fetchTopicMetadata({topics: ["transactions", "transaction_results"]}).then(meta => 
                    Promise.all(meta.topics.map(t => admin.fetchTopicOffsets(t.name)
                    .then(offsets => offsets.map(o => ({topic: t.name, partition: o.partition, offset: o.high}))))))
                .then(offsets => Promise.all(
                    offsets.flat().flat().map(o => admin.deleteTopicRecords({ topic: o.topic, 
                    partitions: [{ partition: o.partition, offset: o.offset}] }))))
            );
    }
    maybeCountKafkaMessages() {
        if (this.checkAvailableCapacity() < MAX_UNCONSUMED_MESSAGE_COUNT / 3 || this.wailtingForReport) {
            return;
        }
        this.wailtingForReport = true;
        const msgSentBefore = this.totalMessageStoredInKafka;
        this.admin.then(admin => {
            admin.listTopics()
            .then(topics => 
                Promise.all(topics.map(t => admin.fetchTopicOffsets(t)))
                .then(offsets => {
                    let total = 0;
                    for (const offsetsPerTopic of offsets) {
                        for (const offset of offsetsPerTopic) {
                            const high = Number.parseInt(offset.high)
                            const low = Number.parseInt(offset.low)
                            total += OverflowingCounter.diff(low, high);
                        }
                    }
                    const msgSentDuringCheck = this.totalMessageStoredInKafka - msgSentBefore;
                    this.totalMessageStoredInKafka = total + msgSentDuringCheck;
                    this.wailtingForReport = false;
                })
            ).catch(e => {
                // Until ungraceful shutdown
                setTimeout(() => {
                    this.wailtingForReport = false;
                    this.maybeCountKafkaMessages()}, 5000);
            })
        });
    }
    private retryDelivery() {
        if (this.retryTimer !== undefined) {
            return;
        }
        this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            this.attemptDelivery();
        }, 1000);
    }

    write(msg: string, topic: string, genTask = false) {
        metrics?.msgPosted.inc();
        if (genTask) {
            this.genTaskPending++;
        } else {
            this.postedPending++;
        }
        this.outbox.push({ topic, partition: 0, msg, now: Date.now(), genTask });
    }
    isBusy(): boolean {
        return this.outbox.length > 0;
    }
  }