import { GenParameters } from "./common/generator_parameters.js";
import { KClient } from "./common/kafka_client.js";
import { Generator, TransactionEvent } from "./generator.js";


const newClient = new KClient("generator")

export class Sender {
    private generator = new Generator();
    private interval: NodeJS.Timeout | undefined = undefined;
    start(params: GenParameters) {
        this.generator.setParameters(params);
        if (this.interval != undefined) {
            return;
        }
        this.interval = setInterval(this.sendEvents, params.generationIntervalMs);
    }
    lastEvent: TransactionEvent = {type: "result", event: {dateTime: 0, transactionID: -1, state: 0}};
    sendEvents() {
        /* convert time increment into proper time of day as 1 second will equal one day */
        this.generator.getEvents().forEach(e => {
            if (this.lastEvent.event.dateTime > e.event.dateTime) {
                throw new Error(`Bad order of generated events old ${JSON.stringify(this.lastEvent)} new ${JSON.stringify(e)}`)
            }
            newClient.write({ msg: JSON.stringify(e.event), topic: e.type });
            this.lastEvent = e;
        })
    }
    stop() {
        this.interval?.close();
        this.interval = undefined;
    }
}
