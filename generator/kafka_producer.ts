import { KClient } from './common/kafka_client.js';
import { logger } from './common/logger.js';
import { metrics, totalmsgSent, updateMaxKafkaSendLatencyMs } from './monitoring_local.js';
import EventEmitter from 'events';
import * as kf from 'kafkajs';



export class KProducer extends EventEmitter {
    public static event = {
        requestMessages: 'requestMessages',
    }
    retryTimer: NodeJS.Timeout | undefined = undefined;
    outbox = new Array<{ topic: string, partition: number, msg: string, now: number }>();

    isConnected = false;
    isStopped = false;
    inFlight = 0;
    producer: kf.Producer;

    /*  "outbox" is a simplified version of reliability guarantee
          during the delivery.
        For delivery of critical information some redundant storage
          would have to be implemented with ensuring
          "exactly once delivery" but it was avoided in this demo.
        Also using array for simplicity (could be an adjustable ring buffer).
        Can automatically batch requests using "linger" and "max_batch_size"
          parameters like Kafka does.
    */
    constructor(private client: KClient, private maxInFlight: number = 1000) {
        super();
        this.producer = this.client.getProducer();
        this.producer.on('producer.connect', () => {
            this.isConnected = true;
            // TODO: test that this will be triggered every time connection was established
            // TODO: also check that the connection will be restored after a break and this will be emit
        })
        this.producer.on('producer.disconnect', () => {
            metrics?.disconnectCount.inc();
            this.isConnected = false;
            if (!this.isStopped) {
                this.producer.connect();
                metrics?.reconnectAttempts.inc();
            }
            // TODO: should i reconnect manually if the connection was broken, or the producer will attempt reconnecting?
        })
        this.producer.on('producer.network.request_timeout', () => {
            metrics?.networkRequestTOCount.inc();
            // TODO: should i reconnect manually if the connection was broken, or the producer will attempt reconnecting?
        })
        this.producer.on('producer.network.request', (data) => {
            metrics?.networkRequestCount.inc();
            // logger.debug(`Network request: ${JSON.stringify(data)}`);
            // TODO: is this something that emit when producer sends? Why?
        })
        this.producer.on('producer.network.request_queue_size', (data) => {
            metrics?.networkRequestCount.inc();
            // logger.debug(`Network request queue size: ${JSON.stringify(data)}`);
            // TODO: is this something that emit when producer sends? Why?
        })
        this.connect();
    }
    connect() {
        this.isStopped = false;
        if (this.isConnected) {
            return;
        }
        this.producer.connect();
    }
    async disconnect() {
        this.isStopped = true;
        this.isConnected = false;
        await this.producer.disconnect();
    }
    getInFlight() {
        return this.inFlight;
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
                this.producer.send({
                    topic: slice[0].topic,
                    messages: slice.map(m => ({ value: m.msg, partition: m.partition })),
                }).then(_ => {
                    updateMaxKafkaSendLatencyMs(Date.now() - slice[0].now);
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
                // logger.debug(`Sending to topic ${m.topic} partition ${m.partition} message: ${m.msg}`);
            }
            if (total == 0) {
                break;
            }
        }
        this.outbox.splice(0, toSend);
        if (this.inFlight < this.maxInFlight / 2) {
            this.emit(KProducer.event.requestMessages, this.maxInFlight - this.inFlight);
        }
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

    write(msg: string, topic: string, partition ?: number) {
        metrics?.msgPosted.inc();
        this.outbox.push({ topic, partition: partition ?? 0, msg, now: Date.now() });
    }
  }