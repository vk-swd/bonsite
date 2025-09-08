import { getEnv } from "./common/utils.js";
import { GenerationState, GenParameters, ProgressReport } from "./common/generator_parameters.js";
import { KClient } from "./common/kafka_client.js";
import { Generator } from "./generator.js";

import { KProducer } from "./kafka_producer.js";

const MAX_IN_FLIGHT = 200;
export class Sender {
    producer = new KProducer(new KClient({ name: "generator", brokers: [getEnv("KAFKA_BROKERS")]}), MAX_IN_FLIGHT)
    generator = new Generator();
    constructor() {
        this.producer.on(KProducer.event.requestMessages, (num: number) => this.sendEvents(num));
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
        this.sendEvents(MAX_IN_FLIGHT)
    }
    sendEvents(num: number) {
        // <= (2 * MAX_IN_FLIGHT - 1) will be in flight
        const events = this.generator.getEvents(num)
        if (events !== undefined) {
            events.forEach(e => this.producer.write(JSON.stringify(e.event), e.topic));
            this.producer.attemptDelivery();
        }
    }
    stop() {
        this.generator.stop();
    }
    isStopped(): boolean {
        return this.producer.getInFlight() === 0 && this.generator.percentComplete() === 100;
    }
}

