import * as kf from 'kafkajs'


const KAFKA_HOSTNAME = process.env.KAFKA_HOSTNAME

export type KMessage = {
  producerId: number,
  seqNumber: number,
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

class KProducer {
  id = 0;
  retryTimer: NodeJS.Timeout | undefined = undefined;
  outbox = new Array<{ msg: KMessage, state: string, topic: string, partition?: number }>();
  isConnected = false;
  isStopped = false;
  stats = new ProducerStats();
  msgIds = new Map<string,number>();
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
    const msgId = this.msgIds.get(topic) ?? 0;
    this.msgIds.set(topic, msgId + 1);
    const mssg = {msg: {message: msg, seqNumber: msgId, producerId: this.id }, state: "idle", topic, partition};
    this.outbox.push(mssg)
    this.attemptDelivery();
  }
}

class ConsumeStats {
  /* Lazy implementation of packet loss calculation
    https://www.ietf.org/rfc/rfc3550.txt
    see A.3 Determining Number of Packets Expected and Lost
    Ideally those would need to be measured per user/transaction type,
      but it would add complexity and is out of scope of this demo.
    Here I just made a rough indicator showing if something broke
      even with such simple setup.
  */
  expectedPackets = 0
  consumedPackets = 0
}
class KConsumer {
  msgIds = new Map<string,ConsumeStats>();
  constructor(private consumer: kf.Consumer) {
    this.consumer.on('consumer.connect', () => {

    })
    this.consumer.on('consumer.crash', () => {
      
    })
    this.consumer.on('consumer.end_batch_process', () => {
      
    })
    this.consumer.on('consumer.network.request', () => {
      
    })
    this.consumer.on('consumer.network.request_timeout', () => {
      
    })
    this.consumer.on('consumer.rebalancing', () => {
      
    })
    this.consumer.on('consumer.fetch', () => {
      
    })
    this.consumer.on('consumer.stop', () => {
      
    })
    this.consumer.on('consumer.commit_offsets', () => {
      
    })
  }
}
export class KClient {
  /*  Single consume/producer per client because
        there is no point running multiple producers/consumers 
        on a single machine with a shared IO (network card and storage device)
      And hardware parallelism is best addressed with extra process in the consumer group.
  */
  private static clientIdCounter = 0;
  private producer: KProducer | undefined = undefined;
  private consumer: kf.Consumer | undefined = undefined;
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
    this.producer.write(msg, topic, partition);
    this.consumer?.commitOffsets();
  }


  async subscribe(topic: string, pos?: number) {
    if (this.consumer === undefined) {
      this.consumer = this.kf.consumer({ groupId: "1" });
      await this.consumer.connect();
      // this.consumer.seek(pos);
      await this.consumer.subscribe({ topic, fromBeginning: false })
      // this.consumer.seek({topic, partition: 1, offset:"0"})
      await this.consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          this.kf.logger().info(JSON.stringify({
            userName: this.config.name,
            topic,
            partition,
            offset: message?.offset ?? 0,
            value: message?.value?.toString() ?? "",
          }))
        },
      })
    }
    // if (!this.subscribedTopics.has(topic)) {
    //   await this.consumer.subscribe({ topic, fromBeginning: true })
    // }
  }
  async unsubscribe() {
    if (this.consumer !== undefined) {
      await this.consumer.disconnect();
      this.consumer = undefined;
    }
    if (this.producer !== undefined) {
      await this.producer.disconnect();
      this.producer = undefined;
    }
  }
};
