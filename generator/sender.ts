import { getEnv } from "./common/utils.js";
import { GenParameters } from "./common/generator_parameters.js";
import { KClient } from "./common/kafka_client.js";
import { Generator, TransactionEvent } from "./generator.js";

import fs from 'fs';
import { clear } from "console";
import { logger } from "./common/logger.js";

export class SenderStats {
    public maxSendIntervalMs: number = 0
    public lastSendTimeMs: number = 0
}

export class Sender {
    public producer = new KClient({ name: "generator", brokers: [getEnv("KAFKA_BROKERS")]}).getProducer()
    private generator = new Generator();
    private timeout: NodeJS.Timeout | undefined = undefined;
    public stats = new SenderStats()

    private stream;
    private lastEvent: {time: number, event?: TransactionEvent} = {time: 0, event: undefined};
    constructor() {
        // console.log(`initial stats ${JSON.stringify(this.stats)}`);
        this.stream = fs.createWriteStream('output.txt', { flags: 'a' }); // 'a' = append
    }
    start(params: GenParameters) {
        // console.log(`starting generator with params ${JSON.stringify(params)} stats ${JSON.stringify(this.stats)}`);
        this.generator.start(params, Date.now());
        if (this.timeout != undefined) {
            return;
        }
        if (params.generationIntervalMs <= 0 || params.generationIntervalMs > 10000) {
            throw new Error(`Invalid generation interval ${params.generationIntervalMs} ms`);
        }
        if (params.maxTransactionsPerSec <= 0 || params.maxTransactionsPerSec > 10000) {
            throw new Error(`Invalid max transactions per second ${params.maxTransactionsPerSec}`);
        }
        // this.stats.lastSendTimeMs = Date.now();
        this.timeout = setTimeout(() => { this.sendEvents()} , params.generationIntervalMs);
    }
    sendEvents() {
        const eventsPerInterval = this.generator.eventsPerInterval();
        if (this.producer.getInFlight() > eventsPerInterval * 2) {
            logger.warn(`Current in-flight messages ${this.producer.getInFlight()} is greater than events per interval ${eventsPerInterval}, skipping sending`);
            this.timeout?.refresh();
            return;
        }
        const now = Date.now();
        this.stats.maxSendIntervalMs = Math.max(now - this.stats.lastSendTimeMs, this.stats.maxSendIntervalMs); 
        this.stats.lastSendTimeMs = now;
        const events = this.generator.getEvents(now)
        if (events === undefined) {
            this.stop();
            return;
        }
        events.forEach(e => this.send(e))
        this.timeout?.refresh()
    }
    stop() {
        if (this.timeout == undefined) {
            return;
        }
        clearTimeout(this.timeout);
        this.timeout = undefined;
    }
    send(event: TransactionEvent) {
        if (this.lastEvent.time > event.event.payload.dateTime) {
            throw new Error(`Bad order of generated events old ${JSON.stringify(this.lastEvent.event)} new ${JSON.stringify(event)}`)
        }
        const msg = JSON.stringify(event.event);
        this.producer.write(msg, event.topic);
        // this.writeOnDisk(`${msg}\n`);
        this.lastEvent.time = event.event.payload.dateTime;
        this.lastEvent.event = event;
    }
    buffer: string[] = [];
    writeOnDisk(line:string) {
        if (this.buffer.length) {
            // waiting for 'drain' event
            this.buffer.push(line);
            return;
        }
        if (this.stream.write(line)) {
            return;
        }
        this.buffer.push(line);
        const sendBuffered = () => {
            while(this.buffer.length) {
                const line = this.buffer[0];
                if (!this.stream.write(line)) {
                    this.stream.once('drain', sendBuffered);
                    break;
                }
                this.buffer.shift();
            }
        }
        this.stream.once('drain', sendBuffered);
    }
}

