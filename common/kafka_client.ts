import * as kf from 'kafkajs'
import { getEnv } from './utils.js';
import { logger } from './logger.js';

const KAFKA_HOSTNAME = getEnv("KAFKA_HOSTNAME");

export type KMessage = {
  producerId: number,
  message: string
}

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

export class KProducer {
  public stats = new ProducerStats();

  id = 0;
  retryTimer: NodeJS.Timeout | undefined = undefined;
  outbox = new Array<{ msg: KMessage, state: string, topic: string, partition?: number }>();
  isConnected = false;
  isStopped = false;
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
    this.producer.on('producer.connect', () => {
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
    this.producer.on('producer.network.request', () => {
      this.stats.networkRequestCount++;
      // TODO: is this something that emit when producer sends? Why?
    })
    this.connect();
  }
  connect() {
    if (this.isConnected) {
      return;
    }
    this.isStopped = false;
    this.producer.connect();
  }
  disconnect() {
    this.isStopped = true;
    this.isConnected = false;
    this.producer.disconnect();
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
      this.stats.msgSent++;
      this.producer.send({
        topic: mssg.topic,
        messages: [
          { value: JSON.stringify(mssg.msg) },
        ]
      })
        .then(res => {
          if (res.length != 1) {
            console.warn(`Sent 1 msg and received more reports or none!: ${JSON.stringify(res)}`)
          }
        })
        .catch(e => {
          console.error(`Failed to send the record because: ${e}`)
          this.outbox.push(mssg)
          this.retryDelivery()
          this.stats.msgFailed++;
        })
    })
    this.retryTimer = undefined;
    this.outbox.length = 0;
  }
  retryDelivery() {
    if (this.retryTimer == undefined) {
      this.stats.retryCount++;
      this.retryTimer = setTimeout(this.attemptDelivery, 1000);
    }
  }
  async write(msg: string, topic: string, partition?: number) {
    const mssg = { msg: { message: msg, producerId: this.id }, state: "idle", topic, partition };
    this.outbox.push(mssg)
    this.attemptDelivery();
  }
}

class ConsumeStats {
  connects = 0
  disconnects = 0
  networkRequestTimeouts = 0
  networkRequests = 0
  fetches = 0
  rebalances = 0
  commits = 0
  endBatchProcesses = 0
  crashes = 0
}

export type KfConsumerSubscription = {
  topic: string,
  partition?: number,
  fromBeginning?: boolean
}

class StateConnected {
  connect() {
    return this; // Already connected, no need to do anything
  }
}
class StateConnecting {
  constructor(private promise: Promise<void>) {

  }
  async connect(): Promise<StateDisconnected| StateConnected> {
    try {
      await this.promise;
    }
    catch (e) {
      console.error(`Failed to connect: ${e}`);
      return new StateDisconnected();
    }
    return new StateConnected();
  }
}
class StateDisconnected {
  async connect(consumer: kf.Consumer): Promise<StateConnecting> {
    return new StateConnecting(consumer.connect());
  }
}

type ConnectionState = StateConnected | StateDisconnected;

enum State {
  Subscribed,
  Unsubscribed,
  Subscribing
}
class KConsumer {
  subscribtions = new Map<string, KfConsumerSubscription>();

  isOn = true; //maybe for later, if we want to turn off consumption
  isConnecting = false;
  isConnected = false;
  retryTimeout: NodeJS.Timeout | undefined = undefined;
  stats = new ConsumeStats();
  subscribedTopics = new Map<string, {pos: number, state: State}>();
  constructor(private consumer: kf.Consumer) {
    this.consumer.on('consumer.connect', () => {
      console.log(`Consumer connected`);
      if (!this.isConnected) {
        this.stats.connects++;
      }
      this.isConnected = true;
      this.isConnecting = false;
      this.subscribeToScheduledTopics();
    })
    this.consumer.on('consumer.disconnect', () => {
      console.warn(`Consumer disconnected`);
      this.stats.disconnects++;
      this.isConnected = false;
      this.isConnecting = false;
    })
    this.consumer.on('consumer.crash', () => {
      this.stats.crashes++;
    })
    this.consumer.on('consumer.end_batch_process', () => {
      this.stats.endBatchProcesses++;
    })
    this.consumer.on('consumer.network.request', () => {
      this.stats.networkRequests++;
    })
    this.consumer.on('consumer.network.request_timeout', () => {
      console.warn(`Consumer network.request_timeout`);
      this.stats.networkRequestTimeouts++;
    })
    this.consumer.on('consumer.rebalancing', () => {
      this.stats.rebalances++;
    })
    this.consumer.on('consumer.fetch', () => {
      console.warn(`Consumer fetching data`);
      this.stats.fetches++;
    })
    this.consumer.on('consumer.stop', () => {

    })
    this.consumer.on('consumer.commit_offsets', () => {

    })
  }
  batchHandler : ((pl: kf.EachBatchPayload) => Promise<void>) | undefined = undefined
  handleBatch(pl: kf.EachBatchPayload): Promise<void> {
    // console.log(`Received batch on topic ${topic} partition ${partition}: ${messages.length} messages`);
    if (this.batchHandler === undefined) {
      console.warn(`No batch handler defined, cannot process batch`);
      return Promise.resolve();
    }
    if (pl.isStale()) {
      console.warn(`Batch is stale, skipping processing for topic ${pl.batch.lastOffset()} at topic ${pl.batch.topic}
          partition ${pl.batch.partition}`);
      return Promise.resolve();
    }
    return this.batchHandler(pl);
  }
  tryConnect() {
    // TODO: make a state machine for clearer connection handling
    if (this.isConnecting || this.isConnected) {
      return;
    }
    this.isConnecting = true;
    return this.consumer.connect()
  }
  async subscribe(topics: [string, number][], handler?: (pl: kf.EachBatchPayload) => Promise<void>) {
    // TODO: do i do reconnection? What to do with subscrivers if if connection is lost
    // who should handle it?
    // should i support manual offset change?
    const newTopics = topics.filter(topic => topic !== undefined && !this.subscribedTopics.has(topic[0]));
    if (newTopics.length != topics.length) {
      console.warn(`Some topics were already subscribed. New: ${newTopics.join(',')} of ${topics.join(',')}`);
    } 
    if (handler !== undefined) {
      this.handleBatch = handler;
    }
    if (newTopics.length == 0) {
      console.warn(`No new topics to subscribe to, skipping subscription`);
      return;
    }
    newTopics.forEach(t => this.subscribedTopics.set(t[0], {pos: t[1], state: State.Unsubscribed}));
    this.subscribeToScheduledTopics();
  }
  async subscribeToScheduledTopics() {
    if (!this.isConnected) {
      return; // wait for connection to be established
    }
    const newTopics = Array.from(this.subscribedTopics).filter(t => t[1].state === State.Unsubscribed);
    if (newTopics.length == 0) {
      return;
    }
    newTopics.forEach(t => {
      t[1].state = State.Subscribing; 
    });
    try {
      await this.consumer.stop();
    } catch (e) {
      console.error(`Failed to subscribe to topics. Can't stop consumption`);
      return;
    }
    try {
      await this.consumer.subscribe({ topics: newTopics.map(t=>t[0]) });
    } catch (e) {
      console.error(`Failed to subscribe to topics ${newTopics.join(',')}: ${e}`);
      newTopics.forEach(t => this.subscribedTopics.delete(t[0]));
      // TODO: signal failed subscription outside
      newTopics.length = 0; // clear the list of new topics
    }
    await this.consumer.run({
      eachBatch: (batch) => this.handleBatch(batch),
      autoCommit: false,
      eachBatchAutoResolve: false
      });
    newTopics.forEach(topic => {
      topic[1].state = State.Subscribed;
      this.consumer.seek({ topic: topic[0], partition: 0, offset: topic[1].pos.toString() })
    });
  }
}
export class KClient {
  /*  Single consume/producer per client because
        there is no point running multiple producers/consumers 
        on a single machine with a shared IO (network card and storage device)
      And hardware parallelism is best addressed with extra process in the consumer group.
  */
  static async consume(config: KClientConfig, topics: [string, number][],handler?: (pl: kf.EachBatchPayload) => Promise<void>): Promise<KClient>{

    
  }
  private static clientIdCounter = 0;
  public producer: KProducer | undefined = undefined;
  public consumer: KConsumer | undefined = undefined;
  private kf: kf.Kafka;
  constructor(public config: KClientConfig) {
    const clientId = `C${KClient.clientIdCounter}_${this.config.name}`
    this.kf = new kf.Kafka({
      // No quotas and authentication/acl => no clientid and ssl/sasl
      clientId,
      brokers: this.config.brokers,
    })
    console.log(`Making client ${clientId} at ${KAFKA_HOSTNAME}`)
  }
  async send(msg: string, topic: string, partition?: number) {
    if (this.producer === undefined) {
      this.producer = new KProducer(this.kf.producer());
    }
    if (this.producer === undefined) {
      console.error(`Producer is not defined, cannot send message to topic ${topic}`);
    }
    this.producer.write(msg, topic, partition);
    // this.consumer?.commitOffsets();
  }

  async subscribe(topics: [string, number][], handler?: (pl: kf.EachBatchPayload) => Promise<void>): Promise<KConsumer> {
    const consumer = new KConsumer(this.kf.consumer({ 
        groupId: "1",
         allowAutoTopicCreation: true, 
         sessionTimeout: 7000,
        heartbeatInterval: 2000}));
    consumer.tryConnect()?.then
    await consumer.subscribe(topics, handler);
    return consumer; 
  }
  // async unsubscribe() {
  //   if (this.consumer !== undefined) {
  //     await this.consumer.disconnect();
  //     this.consumer = undefined;
  //   }
  //   if (this.producer !== undefined) {
  //     await this.producer.disconnect();
  //     this.producer = undefined;
  //   }
  // }
};
