import { unsubscribe } from 'diagnostics_channel';
import * as kf from 'kafkajs'
const KAFKA_HOSTNAME = process.env.KAFKA_HOSTNAME

  
export function last<T>(a: Array<T>): T | undefined {
  return a[a.length - 1];
}

export class KClient {
  /*  Single consume/producer per client because
        there is no point running multiple producers/consumers 
        on a single machine with a shared IO (network card and storage device)
      And hardware parallelism is best addressed with extra process in the consumer group.
  */
  private static counter = 0;
  private producer: kf.Producer | undefined = undefined;
  private consumer: kf.Consumer| undefined = undefined;
  private kf: kf.Kafka;
  private subscribedTopics = new Set<string>();
  constructor(public name: string) {
    this.kf = new kf.Kafka({
      // No quotas and authentication/acl => no clientid and ssl/sasl
      clientId: `C${KClient.counter}_${name}`,
      brokers: [`kafka2:9092`],
      // retry - a retry pattern for connections and api calls.
      // requestTimeout: 2, - millisecs
      // enforceRequestTimeout: true - can disable the request timeout if false
    })
    
    console.log(`creating blokers at ${KAFKA_HOSTNAME}`)
  }
  async write(args: {msg: string, topic: string, partition?: number}) {
      this.kf.logger().info(`write start`)
      if (this.producer === undefined) {
        this.producer = this.kf.producer();
        await this.producer.connect();
      }
      this.kf.logger().info(`connected`)
      await this.producer.send({
        topic: args.topic,
        messages: [
          // { value: args.msg, partition: partition },
        ],
        timeout: 10
      })
      this.kf.logger().info(`sent`)
  }
  async read(topic: string, pos?: number) {
    if (this.consumer === undefined) {
      this.consumer = this.kf.consumer({groupId:"1"});
      await this.consumer.connect();
      // this.consumer.seek(pos);
      await this.consumer.subscribe({ topic, fromBeginning: false })
      // this.consumer.seek({topic, partition: 1, offset:"0"})
      await this.consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          this.kf.logger().info(JSON.stringify({
            userName: this.name,
            topic,
            partition,
            offset: message?.offset??0,
            value: message?.value?.toString()??"",
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
