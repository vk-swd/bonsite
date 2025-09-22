import * as kf from 'kafkajs'
import { getEnv } from './utils.js';
import { logger } from './logger.js';

const KAFKA_HOSTNAME = getEnv("KAFKA_HOSTNAME");

export type KClientConfig = {
  name: string,
  brokers: string[]
}

export class KClient {
  /*  Single consume/producer per client because
        there is no point running multiple producers/consumers
        on a single machine with a shared IO (network card and storage device)
      And hardware parallelism is best addressed with extra process in the consumer group.
  */
  private static clientIdCounter = 0;
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
    return this.kf.producer({retry: {retries: 10}})
  }
};
