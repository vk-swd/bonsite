import { getEnv } from "./common/utils.js";
import { GenerationState, GenParameters, GenRequestError, GenRequestErrorType, ProgressReport } from "./common/generator_parameters.js";
import { KClient } from "./common/kafka_client.js";
import { Generator, TOPICS } from "./generator.js";
import { KProducer } from "./kafka_producer.js";
import { PostTransactionParams } from "./common/generator_parameters.js";

const MAX_IN_FLIGHT = 200;
export class Sender {
    producer = new KProducer(new KClient({ name: "generator", brokers: [getEnv("KAFKA_BROKERS")]}), MAX_IN_FLIGHT)
    generator = new Generator();
    constructor() {
        this.producer.on(KProducer.event.requestMessages, (num: number) => this.sendEvents(num));
    }
    progress(): ProgressReport {
        const toSend = this.generator.getTransactionsToGenerate() * 2;
        const sent = Math.max(0, this.generator.generatedCount() * 2 - this.generator.queueSize() - this.producer.getGenTaskCountPending());
        const progress = sent === toSend ? 100 : sent * 100 / Math.max(toSend,1);
        return {
            postedPending: this.producer.getPostedPending() + this.generator.postedQueueSize(),
            totalSent: this.generator.generatedCount(),
            isRunning: this.isStopped() ? GenerationState.STOPPED : GenerationState.RUNNING,
            percentComplete: Math.floor(progress),
            maxUserId: this.generator.getMaxUserIdGenerated(),
            maxTransactionId: this.generator.getTransactionIdNext(),
            generated: this.generator.getGeneratedDuringSession()
        }
    }
    async postTransaction(userData: PostTransactionParams) {
        this.checkCapacity(2); //throws
        this.generator.postTransaction(userData);
        this.maybeStartSending();
    }
    async start(params: GenParameters) {
        //Don't check capacity because transaction is not posted explicitly
        // await this.producer.dropKafkaRecords();
        this.generator.start(params);
        this.maybeStartSending();
    }
    stop() {
        this.generator.stop();
    }
    private maybeStartSending() {
        if (this.producer.isBusy()) {
            // Producer will request the records when it is ready for more
            return;
        }
        // Start with 1 and producer will request more if needed
        this.sendEvents(1);
    }
    private isStopped(): boolean {
        return this.producer.getGenTaskCountPending() === 0;
    }
    private async checkCapacity(required: number) {
        const awailable = this.producer.checkAvailableCapacity();
        if (awailable < required) {
            throw new GenRequestError(`Kafka full: ${awailable}, required: ${required}`, GenRequestErrorType.KAFKA_FULL);
        }
    }
    private sendEvents(num: number) {
        // <= (2 * MAX_IN_FLIGHT - 1) will be in flight
        const events = this.generator.getEvents(num)
        if (events !== undefined) {
            events.forEach(e => this.producer.write(JSON.stringify(e.event), TOPICS[e.topic].name, !e.isPosted));
            this.producer.attemptDelivery();
        }
    }
}

