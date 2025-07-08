import { GenApiServer } from "./api.js";
import { MonitoringServer, readMetrics } from "./monitoring_local.js";
import { Sender } from "./sender.js";



const sender = new Sender();
const monitoring = new MonitoringServer(() => {
    const producer = sender.client.producer;
    if (!producer) {
        console.warn("No producer available for metrics");
        return;
    }
    readMetrics(producer, sender);
});


const api = new GenApiServer();
api.on('start', sender.start);
api.on('stop', sender.stop);