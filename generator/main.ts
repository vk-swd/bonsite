import { GenParameters } from "./common/generator_parameters.js";
import { GenApiServer } from "./api.js";
import { startMonitoring } from "./monitoring_local.js";
import { Sender } from "./sender.js";

await startMonitoring();

const sender = new Sender();

const api = new GenApiServer(() => sender.progress());
api.on('start', (p: GenParameters) => {
    console.log("Starting sender signaled by API with params", p);
    sender.start(p);  
} );
api.on('stop', () => {sender.stop();});