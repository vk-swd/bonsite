import { GenApiServer } from "./api.js";
import { Sender } from "./sender.js";



const api = new GenApiServer();
const sender = new Sender();

api.on('start', sender.start);
api.on('stop', sender.stop);
