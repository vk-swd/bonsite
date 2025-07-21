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
      this.isConnected = true;
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


class KConsumer {
  subscribtions = new Map<string, KfConsumerSubscription>();

  isOn = true;
  isConnected = false;
  retryTimeout: NodeJS.Timeout | undefined = undefined;
  stats = new ConsumeStats();
  constructor(private consumer: kf.Consumer) {
    this.consumer.on('consumer.connect', () => {
      this.isConnected = true;
      if (this.retryTimeout !== undefined) {
        clearTimeout(this.retryTimeout);
        this.retryTimeout = undefined;
      }
      if (!this.isOn) {
        return;
      }
      // this.consumer.run({
      //   eachMessage: this.handleMessage.bind(this),
      //   autoCommit: false,
      // }).then(() => {

      // }).catch(e => {
      //   console.error(`Failed to run the consumption: ${e}`);
      // });
    })
    this.consumer.on('consumer.disconnect', () => {
      this.stats.disconnects++;
      this.isConnected = false;
      this.retryConnection();
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
      this.stats.networkRequestTimeouts++;
    })
    this.consumer.on('consumer.rebalancing', () => {
      this.stats.rebalances++;
    })
    this.consumer.on('consumer.fetch', () => {
      this.stats.fetches++;
    })
    this.consumer.on('consumer.stop', () => {

    })
    this.consumer.on('consumer.commit_offsets', () => {

    })
    this.tryConnect()
    this.consumer.run({
        // eachMessage: this.handleMessage,
        eachBatch: (batch) => this.handleBatch(batch),
        autoCommit: false,
    })
    // this.consumer.seek(pos);
    // this.consumer.seek({topic, partition: 1, offset:"0"})
  }
  handleBatch(pl: kf.EachBatchPayload): Promise<void> {
    const { topic, partition, messages } = pl.batch;
    const res = this.subscribedTopics.get(topic)
    if (res !== undefined) {
      return res(pl);
    }
    return Promise.resolve();
    // console.log(`Received batch on topic ${topic} partition ${partition}: ${messages.length} messages`);
    // messages.forEach(message => {
    //   this.handleMessage({ topic, partition, message });
    // });

    /* 
    https://kafka.js.org/docs/1.11.0/consuming#a-name-manual-commits-a-manual-committing
    consumer.commitOffsets([
        { topic: 'topic-A', partition: 0, offset: '1' },
        { topic: 'topic-A', partition: 1, offset: '3' },
        { topic: 'topic-B', partition: 0, offset: '2' }
      ])
    */
    /* if the consumer crashed and recovered, it could try and process duplicate data.
      It is database's job to identify such data (it is simple - it woluld have same data
      already written). Consumer will just confirm with database that write is complete and 
      initiate the data commit.
      commits can be chunked if the data is large, but it is not needed in this demo, because
      high load is not tested here
    */

    // this.consumer.commitOffsets(pl.uncommittedOffsets())
    // pl.resolveOffset()
  }
  handleMessage(pl: kf.EachMessagePayload): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        
      const { topic, partition, message } = pl;
      logger.info(JSON.stringify({
        topic,
        partition,
        offset: message?.offset ?? 0,
        value: message?.value?.toString() ?? "",
      }))
    } catch (e) {
        console.error(`Failed to handle message: ${e}`);
        reject(e);
        return;
      }
      resolve();
    });
    // console.log(`Received message on topic ${topic} partition ${partition}: ${message.value?.toString()}`);
  }
  tryConnect() {
    if (this.isConnected || !this.isOn) {
      return;
    }
    this.consumer.connect()
      .catch(e => {
        console.error(`Failed to connect consumer: ${e}`);
        this.retryConnection();
      });
  }
  retryConnection() {
    if (this.retryTimeout !== undefined) {
      return;
    }
    // Do i have to resubscribe manually to everything?
    this.retryTimeout = setTimeout(() => {
      this.tryConnect();
      this.retryTimeout = undefined;
    }, 1000);
  }
  subscribedTopics = new Map<string, (pl: kf.EachBatchPayload) => Promise<void>>(); 
  async subscribe(topic: string, handler: (pl: kf.EachBatchPayload) => Promise<void>, pos?: number) {
    // TODO: do i do reconnection? What to do with subscrivers if if connection is lost
    // who should handle it?
    // should i support manual offset change?
    if (!this.subscribedTopics.has(topic)) {
      this.subscribedTopics.set(topic, handler);
    } else {
      console.warn(`Already subscribed to topic ${topic}, skipping subscription`);
      return;
    }
    if (pos !== undefined) {
      this.consumer.seek({ topic, partition: 0, offset: pos.toString() });
    } else {
      this.consumer.seek({ topic, partition: 0, offset: "0" });
    }
    await this.consumer.stop();
    await this.consumer.subscribe({ topic });
    await this.consumer.run({
      eachBatch: (batch) => this.handleBatch(batch),
      autoCommit: false,})
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
  public consumer: KConsumer | undefined = undefined;
  private kf: kf.Kafka;
  constructor(public config: KClientConfig) {
    this.kf = new kf.Kafka({
      // No quotas and authentication/acl => no clientid and ssl/sasl
      clientId: `C${KClient.clientIdCounter}_${this.config.name}`,
      brokers: this.config.brokers,
    })

    console.log(`creating blokers at ${KAFKA_HOSTNAME}`)
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

  async subscribe(topic: string, handler: (pl: kf.EachBatchPayload) => Promise<void>, pos?: number) {
    if (this.consumer === undefined) {
      this.consumer = new KConsumer(this.kf.consumer({ groupId: "1", allowAutoTopicCreation: true }));
    }
    this.consumer.subscribe(topic, handler, pos);
    // if (!this.subscribedTopics.has(topic)) {
    //   await this.consumer.subscribe({ topic, fromBeginning: true })
    // }
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
