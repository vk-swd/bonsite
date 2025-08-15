import { KClient } from './common/kafka_client.js';
import { logger } from './common/logger.js';
import { metrics } from './monitoring_local.js';
import * as kf from 'kafkajs';



export class KProducer {
    public static event = {
      requestMessages: 'requestMessages',
    }
    retryTimer: NodeJS.Timeout | undefined = undefined;
    outbox = new Array<{ msg: string, topic: string, partition?: number }>();
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
    constructor(private client: KClient) {
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
        logger.debug(`Network request: ${JSON.stringify(data)}`);
        // TODO: is this something that emit when producer sends? Why?
      })
      this.producer.on('producer.network.request_queue_size', (data) => {
        metrics?.networkRequestCount.inc();
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
        metrics?.msgSent.inc();
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
            metrics?.msgFailed.inc();
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
        metrics?.retryCount.inc();
        this.retryTimer = setTimeout(this.attemptDelivery, 1000);
      }
    }
    write(msg: string, topic: string, partition?: number) {
      metrics?.msgPosted.inc();
      this.outbox.push({ msg, topic, partition })
      this.attemptDelivery();
    }
  }