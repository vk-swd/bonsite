
import { getEnv } from './common/utils.js';
import { GenParameters } from './common/generator_parameters.js';
import { last, PriorityQ } from './common/utils.js'
import { InKafkaMessage, Transaction, TransactionResult, TResult } from './common/event_types.js';



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
export type TransactionResultScheduled = {
    dateTime: number,
    event: () => TransactionResult
}


const KAFKA_TOPICS_TRANSACTIONS: string = getEnv("KAFKA_TOPICS_TRANSACTIONS");
const KAFKA_TOPICS_TRANSACTION_RESULTS = getEnv("KAFKA_TOPICS_TRANSACTION_RESULTS");
const MS_PER_SECOND = 1000;
export type TransactionEvent = {topic: string, event: InKafkaMessage, seqNumberer?: () => number};

class TransactionEventsQueue {
    private events = new PriorityQ<TransactionEvent>((a,b) => a.event.payload.dateTime < b.event.payload.dateTime);
    private lastTransactionTime: number | undefined = undefined;
    getLastTransactionTime(): number | undefined {
        return this.lastTransactionTime;
    }
    enqueEvent(event: TransactionEvent) {
        if (event.topic === KAFKA_TOPICS_TRANSACTIONS) {
            this.lastTransactionTime = event.event.payload.dateTime;
        }
        this.events.push(event);
    }
    size(): number {
        return this.events.size();
    }
    dequeEvents(now: number): Array<TransactionEvent> {
        const res = new Array<TransactionEvent>();
        while (!this.events.isEmpty() && this.events.peek()!.event.payload.dateTime < now) {
            res.push(this.events.pop()!);
        }
        return res;        
    }
}

class DelayGenerator {
    /* Though of having a more interesting distribution, but for now
       just a random number between 0 and maxDelayMs */
    constructor(private maxDelayMs: number = 100) {}
    delay(now: number): number {
        return now + Math.random() * this.maxDelayMs;
    }
}
class Counters {
    constructor(
        public transactionCounter: number = 0,
        public transactionResultCounter: number = 0,
    ) {}
}

export class Generator {
    static transactionId = 0;
    static resultTransactionId = 0;
    private queue = new TransactionEventsQueue();
    private currentParams: GenParameters | undefined = undefined;
    private delayGenerator = new DelayGenerator(100);
    start(params: GenParameters, now: number) {
        // Generation is done under assumption that every second represents 1 day
        // Convert the params.requestIntervalMs to dayTimeMs
        this.currentParams = params;
        this.delayGenerator = new DelayGenerator(params.maxDelayMs??100);
        this.queue = new TransactionEventsQueue();
    }
    eventsPerInterval() {
        if (this.currentParams === undefined) {
            throw new Error(`Generator parameters are not set`);
        }
        return this.currentParams.maxTransactionsPerSec * this.currentParams.userCount * this.currentParams.generationIntervalMs / MS_PER_SECOND;
    }
    getEvents(now: number): Array<TransactionEvent> | undefined {
        //TODO now to Date type
        /* high latency might cause overinflated generated sets
        * so chunks of defined generation intervals will be produced.
        */
        if (this.currentParams?.transactionCount !== undefined && this.currentParams?.transactionCount == 0) {
            console.log(`Reached transaction count limit ${this.currentParams.transactionCount}, stopping generation`);
            return undefined;
        }
        const intervalMs: number = this.currentParams?.generationIntervalMs!;
        const lastTransactionTime = this.queue.getLastTransactionTime();
        if (lastTransactionTime == undefined || lastTransactionTime < now) {
            // Generate in seconds to better preserve the "transactionPerSecond" ratio
            const startGenerationTime = Math.max(lastTransactionTime??0, now - intervalMs);
            this.generate(Math.ceil(intervalMs / MS_PER_SECOND) * MS_PER_SECOND, startGenerationTime);
        }
        const events = this.queue.dequeEvents(now);
        for (const e of events) {
            if (e.seqNumberer !== undefined) {
                e.event.metadata.seqNumber = e.seqNumberer();
            }
        }
        if (this.currentParams?.transactionCount !== undefined) { 
            if (this.currentParams.transactionCount > events.length) {
                this.currentParams.transactionCount -= events.length;
            } else {
                const res = events.slice(0, this.currentParams.transactionCount);
                this.currentParams.transactionCount = 0;
                return res;
            }
        }
        return events;
    }
    msgMetaDataPerUser = new Map<number, Counters>();
    anomalyCounter = 0;
    generate(interval: number, now: number) {
        if (this.currentParams == undefined) {
            throw new Error(`Inset generator parameters`)
        }
        /*  Not going for much realism, where consumers rarely have transactions with other consumers
            Also transaction latency is not emulating any thread contention, so 
                transaction result delay will be random.
        */
        const maxTotalEventsPerSec = this.currentParams.maxTransactionsPerSec * this.currentParams.userCount;
        const maxEventsPerInterval = maxTotalEventsPerSec * interval / MS_PER_SECOND ;
        const eventCount = Math.round(Math.random() * maxEventsPerInterval);
        const timeIncrement = interval / Math.max(1, eventCount);
        // console.log(`Generating ${eventCount} events with time increment ${timeIncrement} ms`);
        for (let i = 0; i < eventCount; i++) {
            now += timeIncrement;
            // Can make internal transfers too (same id to and from)
            const userIdFrom = Math.floor(Math.random() * this.currentParams.userCount);
            const userIdTo = Math.floor(Math.random() * this.currentParams.userCount);
            if (this.msgMetaDataPerUser.get(userIdFrom) === undefined) {
                this.msgMetaDataPerUser.set(userIdFrom, new Counters());
            }
            if (this.msgMetaDataPerUser.get(userIdTo) === undefined) {
                this.msgMetaDataPerUser.set(userIdTo, new Counters());
            }
            const transaction: Transaction = {
                id: Generator.transactionId++,
                userIdFrom,
                userIdTo,
                dateTime: Math.floor(now),
                amount: Math.random() * 1000
            }
            const result: TransactionResult = {
                dateTime: this.delayGenerator.delay(now),
                id: transaction.id,
                state: generateTransactionResult()
            }
            const tEvent: InKafkaMessage = { payload: transaction, metadata: 
                { seqNumber: this.msgMetaDataPerUser.get(userIdFrom)!.transactionCounter++, 
                    isIgnored: false } };
            const rEvent: InKafkaMessage = { payload:result, metadata: 
                { seqNumber: 0,
                    isIgnored: false } };
            this.queue.enqueEvent({ topic: KAFKA_TOPICS_TRANSACTIONS, event: tEvent });
            this.queue.enqueEvent({ topic: KAFKA_TOPICS_TRANSACTION_RESULTS, event: rEvent, seqNumberer: () => {
                return this.msgMetaDataPerUser.get(userIdTo)!.transactionResultCounter++;
            }});
        }
    }
    queueSize(): number {
        return this.queue.size();
    }
}

export function testGeneratorContinuous() {
    const gen = new Generator();
    const generationIntervalMs = 100;
    let now = Date.now();
    const params: GenParameters = { userCount: 1000, maxTransactionsPerSec: 5, generationIntervalMs, maxDelayMs: 300 };
    gen.start(params, now);
    const maxEventsPerSec = params.userCount * params.maxTransactionsPerSec * params.generationIntervalMs
    let maxQS = 0;
    let maxConsumed = 0;
    const maxEventsToReserve = Math.ceil(MS_PER_SECOND / generationIntervalMs) * maxEventsPerSec;
    const inter = setInterval(() => {
        const newNow = Date.now();
        console.log(`current pending events ${gen.queueSize()} at ${newNow} ms maxConsumed ${maxConsumed} maxQueueSize ${maxQS}`);
    }, 1000);

    const to1: NodeJS.Timeout = setTimeout(() => {
        const newNow = Date.now();
        if (newNow - now > generationIntervalMs + 200) {
            throw new Error(`Something hangs: ${newNow - now} ms`);
        }
        const maxLeftoverTransactions = generationIntervalMs * maxEventsPerSec / MS_PER_SECOND;
        const maxTransactionResultCountOfOccurredTransactions = Math.ceil(maxEventsPerSec * params.maxDelayMs! / MS_PER_SECOND);
        const maxLeftoverTransacionResults = maxLeftoverTransactions + maxTransactionResultCountOfOccurredTransactions
        const maxLeftoverEventsBeforeMaybeGeneration = maxLeftoverTransacionResults + maxLeftoverTransactions;
        const maxEventsToConsume = Math.ceil((newNow - now) * maxEventsPerSec * 2 / generationIntervalMs);
        const maxQueueSize = maxEventsToConsume + maxLeftoverEventsBeforeMaybeGeneration;
        if (gen.queueSize() >  maxQueueSize) {
            throw new Error(`Queue leaked: ${gen.queueSize()} > ${maxQueueSize}`);
        }
        maxQS = Math.max(maxQS, gen.queueSize());
        const events = gen.getEvents(newNow)!;
        maxConsumed = Math.max(maxConsumed, events.length);
        let lastEventTime = 0;
        for (const e of events) {
            if (e.event.payload.dateTime < lastEventTime) {
                throw new Error(`Events are not ordered: ${e.event.payload.dateTime} < ${lastEventTime}`);
            }
            lastEventTime = e.event.payload.dateTime;
        }
        now = newNow;
        to1.refresh()
    }, generationIntervalMs);
}