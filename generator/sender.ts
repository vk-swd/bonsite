import { getEnv } from "./common/utils.js";
import { GenParameters } from "./common/generator_parameters.js";
import { KClient } from "./common/kafka_client.js";
import { Generator, TransactionEvent } from "./generator.js";

import fs from 'fs';

export class SenderStats {
    maxSendIntervalMs: number = 0
    lastSendTimeMs: number = 0
}

export class Sender {
    public client = new KClient({ name: "generator", brokers: [getEnv("KAFKA_BROKERS")]})
    private generator = new Generator();
    private timeout: NodeJS.Timeout | undefined = undefined;
    public stats = new SenderStats()

    private stream;
    constructor() {
        this.stream = fs.createWriteStream('output.txt', { flags: 'a' }); // 'a' = append
    }
    start(params: GenParameters) {
        this.generator.setParameters(params);
        if (this.timeout != undefined) {
            return;
        }
        const genInterval = params.generationIntervalMs;
        this.stats.lastSendTimeMs = Date.now();
        this.timeout = setTimeout(this.sendEvents, genInterval, genInterval);
    }
    lastEvent: TransactionEvent = {topic: "result", event: {dateTime: 0, transactionID: -1, state: 0}};
    private sendEvents(interval: number) {
        const now = Date.now();
        this.stats.maxSendIntervalMs = Math.max(now - this.stats.lastSendTimeMs, this.stats.maxSendIntervalMs); 
        this.stats.lastSendTimeMs = now;
        /* convert time increment into proper time of day as 1 second will equal one day */
        this.generator.getEvents(interval).forEach(e => this.send(e))
        this.timeout = setTimeout(this.sendEvents, interval, interval);
    }
    stop() {
        this.timeout = undefined;
    }
    send(event: TransactionEvent) {
        if (this.lastEvent.event.dateTime > event.event.dateTime) {
            throw new Error(`Bad order of generated events old ${JSON.stringify(this.lastEvent)} new ${JSON.stringify(event)}`)
        }
        // this.client.send(JSON.stringify(event.event), event.type);
        this.writeOnDisk(`${JSON.stringify(event)}\n`);
        this.lastEvent = event;
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

