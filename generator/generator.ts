
import { getEnv } from './common/utils.js';
import { GenParameters } from './common/generator_parameters.js';
import { last, PriorityQ } from './common/utils.js'
import { InKafkaMessage, Transaction, TransactionResult, TResult } from './common/event_types.js';
import { Counters } from './common/generator_parameters.js';
import { UserCounters } from './common/generator_parameters.js';



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
    enqueEvent(event: TransactionEvent) {
        this.events.push(event);
    }
    size(): number {
        return this.events.size();
    }
    dequeEvents(count: number): Array<TransactionEvent> {
        const res = new Array<TransactionEvent>();
        while (!this.events.isEmpty() && count > 0) {
            res.push(this.events.pop()!);
            count--;
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

export class Generator {
    static transactionId = 0;
    static resultTransactionId = 0;
    private queue = new TransactionEventsQueue();
    private delayGenerator = new DelayGenerator(100);
    private msgMetaDataPerUser = new UserCounters();
    private startTime: number = 0;
    private timeIncrement: number = 0;
    private eventsToGenerate: number = 0;
    private eventsGenerated: number = 0;
    private eventsEnqueued: number = 0;
    private userCount: number = 0;
    private minUserId: number = 0;
    start(params: GenParameters) {
        this.startTime = params.dateFrom;
        const endTime = Math.max(params.dateTo, this.startTime);
        this.timeIncrement = (endTime - this.startTime) / Math.max(params.transactionCount, 1);
        this.delayGenerator = new DelayGenerator(params.maxDelayMs??100);
        this.queue = new TransactionEventsQueue();
        this.eventsEnqueued = 0;
        this.eventsGenerated = 0;
        this.eventsToGenerate = params.transactionCount;
        this.msgMetaDataPerUser.reset();
        if (params.minUserId !== undefined) {
            this.minUserId = params.minUserId;
        }
    }
    stop() {
        this.queue = new TransactionEventsQueue();
        this.eventsEnqueued = 0;
        this.eventsGenerated = 0;
        this.eventsToGenerate = 0;
        this.msgMetaDataPerUser.reset();
        this.minUserId = 0;
    }
    getEvents(count: number): Array<TransactionEvent> | undefined {
        //TODO now to Date type
        /* high latency might cause overinflated generated sets
        * so chunks of defined generation intervals will be produced.
        */
        if (this.eventsEnqueued < count) {
            // generate count * 2 events
            /**How will generation go?
             * 1. take current time
             * 2. al events are going to be generated at time increments so for every event its time will be known
             * 3. generate event at this time + some random delay
             */
            const toGenerate = Math.min(count * 2, this.eventsToGenerate - this.eventsGenerated);
            this.generate(toGenerate);
        }
        if (this.eventsToGenerate == this.eventsGenerated && this.queue.size() == 0) {
            console.log(`Reached transaction count limit ${this.eventsToGenerate}, stopping generation`);
            return undefined;
        }
        const events = this.queue.dequeEvents(count);
        for (const e of events) {
            if (e.seqNumberer !== undefined) {
                e.event.metadata.seqNumber = e.seqNumberer();
            }
            if (e.topic === KAFKA_TOPICS_TRANSACTIONS) {
                this.eventsEnqueued--;
            }
        }
        return events;
    }
    percentComplete(): number {
        return Math.floor(this.eventsGenerated * 100 / Math.max(this.eventsToGenerate + this.queue.size(),1));
    }
    generatedCount(): number {
        return this.eventsGenerated;
    }
    generate(count: number) {
        /*  Not going for much realism, where consumers rarely have transactions with other consumers
            Also transaction latency is not emulating any thread contention, so
                transaction result delay will be random.
        */
        for (let i = this.eventsGenerated; i < this.eventsGenerated + count; i++) {
            const transactionTime = this.startTime + i * this.timeIncrement;
            // Can make internal transfers too (same id to and from)
            const userIdFrom = this.minUserId + Math.floor(Math.random() * this.userCount);
            const userIdTo = this.minUserId + Math.floor(Math.random() * this.userCount);
            const transaction: Transaction = {
                id: Generator.transactionId++,
                userIdFrom,
                userIdTo,
                dateTime: Math.floor(transactionTime),
                amount: Math.random() * 1000
            }
            const result: TransactionResult = {
                dateTime: this.delayGenerator.delay(transactionTime),
                id: transaction.id,
                state: TResult.CONFIRMED,
            }

            const userStatFrom = this.msgMetaDataPerUser.get(userIdFrom);
            const userStatTo = this.msgMetaDataPerUser.get(userIdTo);

            userStatFrom.transactionCount++;
            if (userIdFrom !== userIdTo) {
                userStatTo.transactionCount++;
            }

            const tEvent: InKafkaMessage = { payload: transaction, metadata:
                { seqNumber: userStatFrom.transactionSeqNumber++,
                    isIgnored: false } };
            const rEvent: InKafkaMessage = { payload:result, metadata:
                { seqNumber: 0, // Seq number is accounted only for outgoing transactions
                    isIgnored: false } };

            this.queue.enqueEvent({ topic: KAFKA_TOPICS_TRANSACTIONS, event: tEvent });
            this.queue.enqueEvent({ topic: KAFKA_TOPICS_TRANSACTION_RESULTS, event: rEvent, seqNumberer: () => {
                return this.msgMetaDataPerUser.get(userIdTo)!.transactionResultSeqNumber++;
            }});
        }
        this.eventsGenerated += count;
        this.eventsEnqueued += count;
    }
    queueSize(): number {
        return this.queue.size();
    }
    getStat(): UserCounters {
        return this.msgMetaDataPerUser;
    }
}

export function testGeneratorContinuous() {
    const cycles = 100;
    for (let i = 0; i < cycles; i++) {
        const gen = new Generator();
        const eventCount = 100000;
        const startTime = 100;
        const params: GenParameters = {
            userCount: 1000,
            dateFrom: startTime,
            dateTo: startTime + Math.random() * eventCount,
            transactionCount: eventCount,
            maxDelayMs: 500};
        gen.start(params);
        const events = gen.getEvents(eventCount * 2)!; // get all events
        let lastEventTime = startTime - 1;
        for (const e of events) {
            if (e.event.payload.dateTime < lastEventTime) {
                throw new Error(`Events are not ordered: ${e.event.payload.dateTime} < ${lastEventTime}`);
            }
            lastEventTime = e.event.payload.dateTime;
        }
        process.stdout.clearLine(0);   // clear current line
        process.stdout.cursorTo(0);    // move cursor to beginning of line
        process.stdout.write(`Progress: ${i * 100 / cycles}%`);
    }
    console.log("Generator test passed");
}