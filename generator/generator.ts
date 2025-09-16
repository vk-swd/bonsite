
import { getEnv } from './common/utils.js';
import { GenParameters } from './common/generator_parameters.js';
import { last, PriorityQ } from './common/utils.js'
import { InKafkaMessage, Transaction, TransactionResult, TResult } from './common/event_types.js';
import { Counters } from './common/generator_parameters.js';
import { UserCounters } from './common/generator_parameters.js';
import { PostTransactionParams } from './common/generator_parameters.js';



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
export type TransactionEvent = {topic: string, event: InKafkaMessage};

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
    private transactionId = 0;
    static resultTransactionId = 0;
    private queue = new TransactionEventsQueue();
    private delayGenerator = new DelayGenerator(100);
    private msgMetaDataPerUser = new UserCounters();
    private startTime: number = 0;
    private timeIncrement: number = 0;
    private transactionsToGenerate: number = 0;
    private transactionsGenerated: number = 0;
    private transactionsEnqueued: number = 0;
    private userCount: number = 0;
    private minUserId: number = 0;
    private maxUserId: number = 0;
    private generatedDuringSession: number = 0;
    private stopped = true;
    start(params: GenParameters) {
        this.stop();
        this.stopped = false;
        this.msgMetaDataPerUser.reset();
        this.startTime = params.dateFrom;
        this.generatedDuringSession = 0;
        this.transactionsGenerated = 0;
        const endTime = Math.max(params.dateTo, this.startTime);
        this.timeIncrement = (endTime - this.startTime) / Math.max(params.transactionCount, 1);
        this.delayGenerator = new DelayGenerator(params.maxDelayMs??100);
        this.transactionsToGenerate = params.transactionCount;
        this.userCount = params.userCount;
        if (params.minUserId !== undefined) {
            this.minUserId = params.minUserId;
        }
        if (params.minTransactionId !== undefined) {
            this.transactionId = params.minTransactionId;
        }
    }
    getTransactionIdNext(): number {
        return this.transactionId;
    }
    getMaxUserIdGenerated(): number {
        return this.maxUserId;
    }
    getGeneratedDuringSession(): number {
        return this.generatedDuringSession;
    }
    stop() {
        this.queue = new TransactionEventsQueue();
        this.transactionsEnqueued = 0;
        this.stopped = true;
    }
    getTransactionsToPost(params: PostTransactionParams): TransactionEvent[] {
        const [t,r] = this.getTransaction(params.userFrom, params.userTo, params.amount, params.date, params.date, TResult.CONFIRMED);
        return [{ topic: KAFKA_TOPICS_TRANSACTIONS, event: t },
            { topic: KAFKA_TOPICS_TRANSACTION_RESULTS, event: r }];
    }
    getEvents(count: number): Array<TransactionEvent> | undefined {
        if (this.stopped || this.transactionsToGenerate == this.transactionsGenerated && this.queue.size() == 0) {
            this.stopped = true;
            return undefined;
        }
        if (this.transactionsEnqueued < count) {
            // generate count * 2 transactions
            const toGenerate = Math.min(count * 2, this.transactionsToGenerate - this.transactionsGenerated);
            this.generate(toGenerate);
        }
        const events = this.queue.dequeEvents(count);
        for (const e of events) {
            if (e.topic === KAFKA_TOPICS_TRANSACTIONS) {
                this.transactionsEnqueued--;
            }
        }
        return events;
    }
    generatedCount(): number {
        return this.transactionsGenerated;
    }
    getTransactionsToGenerate(): number {
        return this.transactionsToGenerate;
    }
    private getTransaction(userIdFrom: number, userIdTo: number, amount: number, 
        transactionTime: number, datetimeR: number, state: TResult): [InKafkaMessage, InKafkaMessage] {
        const transaction: Transaction = {
            id: this.transactionId++,
            userIdFrom,
            userIdTo,
            dateTime: transactionTime,
            amount
        }
        const result: TransactionResult = {
            dateTime: datetimeR,
            id: transaction.id,
            state,
        }
        this.maxUserId = Math.max(this.maxUserId, userIdFrom, userIdTo);
        this.msgMetaDataPerUser.incrementStat(userIdFrom, amount, transaction.dateTime);
        this.generatedDuringSession+=2;
        if (userIdFrom !== userIdTo) {
            this.msgMetaDataPerUser.incrementStat(userIdTo, amount, transaction.dateTime);
        }
        return [{ payload: transaction, metadata: { } }, { payload:result, metadata: { } }];
    }
    getnUserId(): number {
        return this.minUserId + Math.floor(Math.random() * this.userCount);
    }
    generate(count: number) {
        /*  Not going for much realism, where consumers rarely have transactions with other consumers
            Also transaction latency is not emulating any thread contention, so
                transaction result delay will be random.
        */
        for (let i = this.transactionsGenerated; i < this.transactionsGenerated + count; i++) {
            const transactionTime =  Math.floor(this.startTime + i * this.timeIncrement);
            // Can make internal transfers too (same id to and from)
            const amount = 1 + Math.floor(Math.random() * 1000);
            const [tEvent, rEvent] = this.getTransaction(this.getnUserId(), this.getnUserId(), 
                amount, transactionTime, 
                this.delayGenerator.delay(transactionTime), 
                TResult.CONFIRMED);
            this.queue.enqueEvent({ topic: KAFKA_TOPICS_TRANSACTIONS, event: tEvent });
            this.queue.enqueEvent({ topic: KAFKA_TOPICS_TRANSACTION_RESULTS, event: rEvent });
        }
        this.transactionsGenerated += count;
        this.transactionsEnqueued += count;
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