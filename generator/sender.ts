import { getEnv } from "./common/utils.js";
import { GenParameters } from "./common/generator_parameters.js";
import { KClient } from "./common/kafka_client.js";
import { Generator, TransactionEvent } from "./generator.js";

import fs from 'fs';
import { clear } from "console";

export class SenderStats {
    public maxSendIntervalMs: number = 0
    public lastSendTimeMs: number = 0
}

export class Sender {
    public client = new KClient({ name: "generator", brokers: [getEnv("KAFKA_BROKERS")]})
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
        this.generator.setParameters(params);
        if (this.timeout != undefined) {
            return;
        }
        const genInterval = params.generationIntervalMs;
        // this.stats.lastSendTimeMs = Date.now();
        this.timeout = setTimeout(() => { this.sendEvents(genInterval)} , genInterval);
    }
    sendEvents(interval: number) {
        const now = Date.now();
        this.stats.maxSendIntervalMs = Math.max(now - this.stats.lastSendTimeMs, this.stats.maxSendIntervalMs); 
        this.stats.lastSendTimeMs = now;
        /* convert time increment into proper time of day as 1 second will equal one day */
        const events = this.generator.getEvents(interval)
        console.log(`Sending events ${JSON.stringify(events)} every ${interval} ms stats ${JSON.stringify(this.stats)} and this ${JSON.stringify(this.lastEvent)} and ${this}`);
        
        events.forEach(e => this.send(e))
        this.timeout = setTimeout(() => { this.sendEvents(interval) }, interval);
    }
    stop() {
        if (this.timeout == undefined) {
            return;
        }
        clearTimeout(this.timeout);
        this.timeout = undefined;
    }
    send(event: TransactionEvent) {
        if (this.lastEvent.time > event.event.dateTime) {
            throw new Error(`Bad order of generated events old ${JSON.stringify(this.lastEvent.event)} new ${JSON.stringify(event)}`)
        }
        const msg = JSON.stringify(event.event);
        this.client.send(msg, event.topic);
        // this.writeOnDisk(`${msg}\n`);
        this.lastEvent.time = event.event.dateTime;
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

