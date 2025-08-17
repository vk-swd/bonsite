import { getEnv } from "./common/utils.js";
import { GenerationState, GenParameters, ProgressReport } from "./common/generator_parameters.js";
import { KClient } from "./common/kafka_client.js";
import { Generator, TransactionEvent } from "./generator.js";

import { KProducer } from "./kafka_producer.js";

export class Sender {
    public producer = new KProducer(new KClient({ name: "generator", brokers: [getEnv("KAFKA_BROKERS")]}))
    private generator = new Generator();
    constructor() {
        this.producer.on(KProducer.event.requestMessages, () => this.sendEvents());
    }
    progress(): ProgressReport {
        return {
            totalSent: this.generator.generatedCount(),
            isRunning: this.isStopped() ? GenerationState.STOPPED : GenerationState.RUNNING,
            percentComplete: this.generator.percentComplete()
        }
    }
    start(params: GenParameters) {
        this.generator.start(params);
        this.sendEvents()
    }
    sendEvents() {
        const inFlight = this.producer.getInFlight();
        if (inFlight > 100) {
            return;
        }
        const events = this.generator.getEvents(100)
        if (events !== undefined) {
            events.forEach(e => this.producer.write(JSON.stringify(e.event), e.topic))
        }
    }
    stop() {
        this.generator.stop();
    }
    isStopped(): boolean {
        return this.producer.getInFlight() == 0 && this.generator.percentComplete() === 100;
    }
}

