import { GenParameters } from "./common/generator_parameters.js";
import { GenApiServer } from "./api.js";
import { localReg, MonitoringServer, mt, readMetrics } from "./monitoring_local.js";
import { Sender } from "./sender.js";

const sender = new Sender();
const monitoring = new MonitoringServer(() => {
    mt();
    const producer = sender.producer;
    if (!producer) {
        console.warn("No producer available for metrics");
        return;
    }
    readMetrics(producer, sender);
}, localReg);


const api = new GenApiServer();
api.on('start', (p: GenParameters) => {
    console.log("Starting sender signaled by API with params", p);
    sender.start(p);  
} );
api.on('stop', () => {sender.stop();});