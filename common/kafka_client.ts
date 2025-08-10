import * as kf from 'kafkajs'
import { getEnv, KConsumerOffsetInfo } from './utils.js';
import { logger } from './logger.js';
import { EventEmitter } from 'events';
import PQueue from 'p-queue';
import { threadId } from 'worker_threads';

const KAFKA_HOSTNAME = getEnv("KAFKA_HOSTNAME");

export type KClientConfig = {
  name: string,
  brokers: string[]
}
class ProducerStats {
  public disconnectCount: number = 0
  public networkRequestTOCount: number = 0
  public networkRequestCount: number = 0
  public msgPosted: number = 0
  public msgSent: number = 0
  public msgFailed: number = 0
  public reconnectAttempts: number = 0
  public retryCount: number = 0
}

export class KProducer extends EventEmitter {
  public stats = new ProducerStats();
  public static event = {
    requestMessages: 'requestMessages',
  }
  retryTimer: NodeJS.Timeout | undefined = undefined;
  outbox = new Array<{ msg: string, topic: string, partition?: number }>();
  isConnected = false;
  isStopped = false;
  queue = new PQueue({concurrency: 100, autoStart: true});
  inFlight = 0;

  /*  "outbox" is a simplified version of reliability guarantee 
        during the delivery.
      For delivery of critical information some redundant storage 
        would have to be implemented with ensuring 
        "exactly once delivery" but it was avoided in this demo.
      Also using array for simplicity (could be an adjustable ring buffer).
      Can automatically batch requests using "linger" and "max_batch_size"
        parameters like Kafka does.
  */
  constructor(private producer: kf.Producer) {
    super();
    this.producer.on('producer.connect', () => {
      this.isConnected = true;
      this.queue.size
      // TODO: test that this will be triggered every time connection was established
      // TODO: also check that the connection will be restored after a break and this will be emit
    })
    this.producer.on('producer.disconnect', () => {
      this.stats.disconnectCount++;
      this.isConnected = false;
      if (!this.isStopped) {
        this.producer.connect();
        this.stats.reconnectAttempts++;
      }
      // TODO: should i reconnect manually if the connection was broken, or the producer will attempt reconnecting?
    })
    this.producer.on('producer.network.request_timeout', () => {
      this.stats.networkRequestTOCount++;
      // TODO: should i reconnect manually if the connection was broken, or the producer will attempt reconnecting?
    })
    this.producer.on('producer.network.request', (data) => {
      this.stats.networkRequestCount++;
      logger.debug(`Network request: ${JSON.stringify(data)}`);
      // TODO: is this something that emit when producer sends? Why?
    })
    this.producer.on('producer.network.request_queue_size', (data) => {
      this.stats.networkRequestCount++;
      logger.debug(`Network request queue size: ${JSON.stringify(data)}`);
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
  disconnect() {
    this.isStopped = true;
    this.isConnected = false;
    this.producer.disconnect();
  }
  getInFlight() {
    return this.inFlight;
  }
  attemptDelivery() {
    if (!this.isConnected) {
      return;
    }
    /* Decided not to overcomplicate things and not to do manual batching,
          because according to documentation Kafka already does this
          + optmising without strong prompting evidence can be unreasonable.
        With high latency and message bandwidth data can be lost if the 
          outbox structure is not backed up properly, but such guarantees are
          beyond the scope of this project.
    */
   this.outbox.forEach(mssg => {
      this.inFlight++;
      this.stats.msgSent++;
      this.producer.send({
        topic: mssg.topic,
        messages: [
          { value: mssg.msg, partition: mssg.partition } // key is optional, but can be used for partitioning
        ]
      })
        .then(_ => {
          this.inFlight--;
        })
        .catch(e => {
          this.inFlight--;
          this.stats.msgFailed++;
          if (!this.isStopped) {
            // Relying on KafkaJS built-in retries to prevent busy looping in case of send failures.
            this.outbox.push(mssg)
            this.retryDelivery()
          }
        })
    });
    this.retryTimer = undefined;
    this.outbox.length = 0;
  }
  retryDelivery() {
    if (this.retryTimer == undefined) {
      this.stats.retryCount++;
      this.retryTimer = setTimeout(this.attemptDelivery, 1000);
    }
  }
  write(msg: string, topic: string, partition?: number) {
    this.outbox.push({ msg, topic, partition })
    this.attemptDelivery();
  }
}

export class KClient {
  /*  Single consume/producer per client because
        there is no point running multiple producers/consumers 
        on a single machine with a shared IO (network card and storage device)
      And hardware parallelism is best addressed with extra process in the consumer group.
  */
  private static clientIdCounter = 0;
  public producer: KProducer | undefined = undefined;
  private kf: kf.Kafka;
  constructor(public config: KClientConfig) {
    const clientId = `C${KClient.clientIdCounter}_${this.config.name}`
    this.kf = new kf.Kafka({
      // No quotas and authentication/acl => no clientid and ssl/sasl
      clientId,
      brokers: this.config.brokers,
    })
    logger.log(`Making client ${clientId} at ${KAFKA_HOSTNAME}`)
  }
  getProducer() {
    if (this.producer === undefined) {
      this.producer = new KProducer(this.kf.producer({retry: {retries: 10}}));
    }
    return this.producer;
  }
  async send(msg: string, topic: string, partition?: number) {
    if (this.producer === undefined) {
      this.producer = new KProducer(this.kf.producer());
    }
    this.producer.write(msg, topic, partition);
  }
};
