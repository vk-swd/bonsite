
import { KClient, last } from '../common/kafka_client.js'
import { PriorityQ, testQ } from '../common/utils.js'


const newClient = new KClient("generator")

type Transaction = {
    id: number,
    userIdFrom: number,
    userIdTo: number,
    dateTime: number,
    amount: number,
    description?: string,
    merchantInfo?: string,
    location?: string,
}

enum TResult {
    CONFIRMED = 0,
    TIMEOUT = 1,
    FRAUD = 2,
    BLOCKED = 3
}

type TransactionResult = {
    transactionID: number,
    dateTime: number,
    state: TResult
}

const delayedEvents = new PriorityQ<TransactionResult>((a, b) => a.dateTime < b.dateTime);
const eventArray = new Array<{qSize?: number, t: Transaction}>();


let now = 0;
const interval = 10;


let transactionId = 0;

const USER_COUNT = 100;
const EVENT_RATE = [10, 1000]
const EVENT_GEN_INTERVAL_MS = 100
let tResolutionEventStartIdx = 0;
let tRequestEventStartIdx = 0;
function generate() {
    /*  Not going for much realism (consumers rarely have transactions with other consumers)
        Also transaction latency is not emulating any thread contention.    
    */
    const eventCount = EVENT_RATE[0] + Math.random() * (EVENT_RATE[1] - EVENT_RATE[0]);
    const timeIncrement = EVENT_GEN_INTERVAL_MS / eventCount;
    
    for (let i = 0; i < eventCount; i++) {
        now += timeIncrement;
        const userIdFrom = Math.floor(Math.random() * USER_COUNT);
        const userIdTo = (userIdFrom + Math.floor(Math.random() * USER_COUNT) - 1) % USER_COUNT;
        const event: Transaction = {
            id: transactionId++,
            userIdFrom,
            userIdTo,
            dateTime: now,
            amount: Math.random() * 1000
        }
        eventArray.push({t: event});
        const resultEvent = {
            dateTime: Math.random() * 100,
            transactionID: event.id,
            state: generateTransactionResult()
        }
        delayedEvents.push(resultEvent);
    }
}

function generateTransactionResult() {
    const val = Math.random() * 100;
    if (val > 95) {
        return TResult.TIMEOUT
    } else if (val > 90) {
        return TResult.FRAUD
    } else if (val > 10) {
        return TResult.CONFIRMED
    } else {
        return TResult.BLOCKED
    }
}

let lastEvent: Transaction | TransactionResult = {dateTime: 0, transactionID: 0, state: TResult.CONFIRMED};
function writeToKafka(event: Transaction | TransactionResult, topic: string) {
    if (lastEvent.dateTime > event.dateTime) {
        throw new Error(`Bad order of generated events old ${JSON.stringify(lastEvent)} new ${JSON.stringify(event)}`)
    }
    newClient.write({ msg: JSON.stringify(event), topic })
    lastEvent = event;
}
const writeTimeout = setInterval(() => {
    now += interval;
    if (eventArray.length == 0 || last(eventArray)!.t.dateTime < now) {
        generate();
    }
    let tPos = tRequestEventStartIdx;
    let tResultPos = tResolutionEventStartIdx;
    /*
        If eventArray has elements, then delayedEvents will also have them, because:
            1) More events are planned then going to be consumed in any single interval
            2) for every planned event, there will always be a result in delayedEvents.
    */
    while (tPos < eventArray.length && eventArray[tPos].t.dateTime < now) {
        if (eventArray[tPos].t.dateTime <= delayedEvents.peek()!.dateTime) {
            writeToKafka(eventArray[tPos].t, "Transactions")
            tPos++;
        } else {
            writeToKafka(delayedEvents.pop()!, "TransactionsResults")
        }
    }
    while (delayedEvents.peek() !== undefined && delayedEvents.peek()!.dateTime < now) {
        writeToKafka(delayedEvents.pop()!, "TransactionsResults")
    }
    tResolutionEventStartIdx = tResultPos;
    tRequestEventStartIdx = tPos;
    if (tRequestEventStartIdx > eventArray.length / 2) {
        eventArray.splice(0, tRequestEventStartIdx);
        tRequestEventStartIdx = 0;
    }
}, interval);

// const BEST_Q_SIZE = 1000 // all Ts will have 0 latency
// const STABLE_Q_SIZE = BEST_Q_SIZE * 3 // all Ts will have latency [20mms,150ms]
// const UNSTABLE_Q_SIZE = STABLE_Q_SIZE * 2 // random 300ms freezes will be introduced
// const TRANSACTION_TIMEOUT_MS = 3000; // transactions will be declined due to system error - monitor it.

// let latency = 1;
// if (eventArray.length == 0) {
//     eventArray.push({t: event});
//     delayedEvents.push({dateTime: now + latency, transactionID: event.id, state: TResult.CONFIRMED});
//     continue;
// }
// const lastEvent = last(eventArray)!
// const nextDelayed = delayedEvents[delayedEvents.length - lastEvent.qSize - 1]
// while (delayedEvents[tResolutionEventStartIdx].dateTime < now) {
//     tResolutionEventStartIdx++;
// }
// const queueSize = delayedEvents.length - tResolutionEventStartIdx;
// if (queueSize > UNSTABLE_Q_SIZE) {
//     latency = TRANSACTION_TIMEOUT_MS;
// } else if (queueSize > STABLE_Q_SIZE) {
//     latency = 300 + Math.random() * 1000
// } else if (queueSize > BEST_Q_SIZE) {
//     latency = 20 + Math.random() * 130
// }