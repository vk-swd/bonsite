import { getEnv } from "./common/utils.js";
import { GenParameters } from "./common/generator_parameters.js";
import { KClient } from "./common/kafka_client.js";
import { Generator, TransactionEvent } from "./generator.js";



export class SenderStats {
    maxSendIntervalMs: number = 0
    lastSendTimeMs: number = 0
}

export class Sender {
    public client = new KClient({ name: "generator", brokers: [getEnv("KAFKA_BROKERS")]})
    private generator = new Generator();
    private timeout: NodeJS.Timeout | undefined = undefined;
    public stats = new SenderStats()
    start(params: GenParameters) {
        this.generator.setParameters(params);
        if (this.timeout != undefined) {
            return;
        }
        const genInterval = params.generationIntervalMs;
        this.stats.lastSendTimeMs = Date.now();
        this.timeout = setTimeout(this.sendEvents, genInterval, genInterval);
    }
    lastEvent: TransactionEvent = {type: "result", event: {dateTime: 0, transactionID: -1, state: 0}};
    private sendEvents(interval: number) {
        const now = Date.now();
        this.stats.maxSendIntervalMs = Math.max(now - this.stats.lastSendTimeMs, this.stats.maxSendIntervalMs); 
        this.stats.lastSendTimeMs = now;
        /* convert time increment into proper time of day as 1 second will equal one day */
        this.generator.getEvents(interval).forEach(e => {
            if (this.lastEvent.event.dateTime > e.event.dateTime) {
                throw new Error(`Bad order of generated events old ${JSON.stringify(this.lastEvent)} new ${JSON.stringify(e)}`)
            }
            this.client.send(JSON.stringify(e.event), e.type);
            this.lastEvent = e;
        })
        this.timeout = setTimeout(this.sendEvents, interval, interval);
    }
    stop() {
        this.timeout = undefined;
    }
}
