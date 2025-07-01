



// function setVal<T>(someMap: Map<string, T>, key: string) {
    
// }


// // const makeUser = require("./go").makeUser

// import { exit } from "process";
// import {makeUser, User} from "./go.js"

// import * as kf from 'kafkajs'
// // setInterval(() => {
//     // run().catch(console.error)
// // }, 4000)

// const kafka = new kf.Kafka({
// // No quotas and authentication/acl => no clientid and ssl/sasl
//   brokers: ['kafka2:9092']
// })

// const admin = kafka.admin()
// console.log(`Hello World!`);
// await admin.connect()

// console.log(`${(await admin.listTopics()).join(';')}`);
// const md = await admin.fetchTopicMetadata()
// console.log(`fetchTopicMetadata: ${JSON.stringify(md)}`);
// const cluster = await admin.describeCluster();
// console.log(`cluster: ${JSON.stringify(cluster)}`)
// // const u1 = await makeUser("g1", "u1")
// // const u1 = await makeUser("g1", "u2")

// // await u1.write(new Date().toLocaleTimeString(), "t1");
// // await u1.write(new Date().toLocaleTimeString(), "t1");
// // console.log(`===================+${new Date().toLocaleTimeString()}`)
// // await u1.read("t1");
// // console.log(`=========sdfsdf==========+${new Date().toLocaleTimeString()}`)


// // setTimeout(async () => {
// //     console.log(`${new Date().toLocaleTimeString()}: unsubscribing`)
// //  await u1.unsubscribe();
// //  console.log(`${new Date().toLocaleTimeString()}: done`)
// //  exit();
// // }, 1000)
// // await u2.read("t1");

// let users = new Map<string, Map<string, User>>();
// function addUsr(group:string, id:string) {
//     let g = users.get(group);
//     if (g == undefined) {
//         g = new Map<string, User>();
//         users.set(group, g);
//     }
//     let u = g.get(id);
//     if (u == undefined) {
//         u = new User(group,id);
//         g.set(id, u);
//     }
// }
// function getUsr(group:string, id:string) {
//     return users.get(group)?.get(id);
// }
// function rmUsr(group:string, id:string) {
//     let g = users.get(group);
//     if (g == undefined) {
//         return;
//     }
//     g.delete(id);
//     if (g.size == 0) {
//         users.delete(group);
//     }
// }

// /* Cases to test:
//     1) 
//         * add topic with 3 partitions
//         * make 3 users writing to all of them
//         * make 1 user consuming from all of them
//         *   take note of how he chooses partitions 
//         *       check order
//         *       check that one partition is cleared before another is read    
//         * make 2 users consuming from all of them
//         *   take note of the order.
//         * 
//     2)  
//         * U1 ocnsumes P1, 
//         * U2 consumes P2, 
//         * U2 seeks to the start of P1, 
//         * U1 consumes P1 
//         * see if the P offset is for the whole group.
     

// */
// // process.stdin.on("data", (data: string) => {
// //     const tokens = data.split(' ');
// //     if (tokens.length == 0) {
// //         return;
// //     }
// //     switch (tokens[0]) {
// //         case "useradd":
// //             if (tokens.length < 3) {
// //                 console.log("Not enough arguments to add user. Need user group and user id.")
// //                 return;
// //             }
// //             addUsr(tokens[1], tokens[2])
// //             break;
// //         case "userdel":
// //             if (tokens.length < 3) {
// //                 console.log("Not enough arguments to del user. Need user group and user id.")
// //                 return;
// //             }
// //             rmUsr(tokens[1], tokens[2])
// //             break;
// //         case "write": {
// //             if (tokens.length < 5) {
// //                 console.log("Not enough arguments to write. Need user group and user id and topic and msg.")
// //                 return;
// //             }
// //             const u = getUsr(tokens[1], tokens[2]);
// //             if (u == undefined) {
// //                 console.log("Weird user to write to. Cmd: " + data)
// //                 return;
// //             }
// //             u.write(tokens.slice(4).join(' '), tokens[3]);
// //             break;
// //         }
// //         case "sub": {
// //             if (tokens.length < 3) {
// //                 console.log("Not enough arguments to write. Need user group and user id and topic and pos.")
// //                 return;
// //             }
// //             const u = getUsr(tokens[1], tokens[2]);
// //             if (u == undefined) {
// //                 console.log("Weird user to read from. Cmd: " + data)
// //                 return;
// //             }
// //             u.read(tokens[3], parseInt(tokens[4], 10))
// //             break;
// //         }
// //         case "unsub": {

// //             break;
// //         }
// //         default:
// //             break;
// //     }
// // });