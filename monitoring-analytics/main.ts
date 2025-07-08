
import * as kf from 'kafkajs'
import { KClient } from '../common/kafka_client.js'
import { getEnv, testQ } from './common/utils.js';
import { exit } from 'process';

import * as prom from 'prom-client'


const PORT = getEnv("M_PORT");

const cnt1 = new prom.Counter({name: "testCounter", help: "beresh i countish"});
setInterval(() => {
    cnt1.inc(3);    
}, 100);


// const reg = new prom.Registry();
// reg.registerMetric(cnt1)

// setInterval(() => {
    
//     prom.register.metrics().then(r => {
//     console.log(`Regustered metrics: ${r}`)
//     });
// }, 1000);





import http from 'http';


const server = http.createServer(async (req, res) => {
  if (req.url === '/metrics') {
    res.setHeader('Content-Type', prom.register.contentType);
    res.end(await prom.register.metrics());
  }
});

server.listen(PORT, () => {
  console.log('Listening on http://localhost:3000, metrics on /metrics');
});








// exit();


// const newClient = new KClient("analytics")

// // type KEvent = {
// //     userId: number,
// //     dateTime: Date,
// //     amount: number,
// //     description?: string,
// //     merchantInfo?: string,
// //     location?: string,
// // }

// /*  Users: 1-100
//     amounts: 1-1000
//     types: 1-15
//     locaitons: 1-50
// */
// newClient.read("Transactions");

