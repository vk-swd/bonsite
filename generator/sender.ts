import { getEnv } from "./common/utils.js";
import { GenerationState, GenParameters, ProgressReport } from "./common/generator_parameters.js";
import { KClient } from "./common/kafka_client.js";
import { Generator, TransactionEvent } from "./generator.js";

import { logger } from "./common/logger.js";
import { KProducer } from "./kafka_producer.js";

export class SenderStats {
    public maxSendIntervalMs: number = 0
    public lastSendTimeMs: number = 0
}

export class Sender {
    public producer = new KProducer(new KClient({ name: "generator", brokers: [getEnv("KAFKA_BROKERS")]}))
    private generator = new Generator();
    private timeout: NodeJS.Timeout | undefined = undefined;
    public stats = new SenderStats()

    private lastEvent: {time: number, event?: TransactionEvent} = {time: 0, event: undefined};

    progress(): ProgressReport {
        return {
            totalSent: this.generator.generatedCount(),
            totalUsers: this.generator.userCount(),
            isRunning: this.isStopped() ? GenerationState.STOPPED : GenerationState.RUNNING,
            percentComplete: this.generator.percentComplete()
        }
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
    isStopped(): boolean {
        return this.timeout === undefined;
    }
    stop() {
        if (this.isStopped()) {
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
}

