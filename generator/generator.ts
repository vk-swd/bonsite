
import { getEnv, OverflowingCounter } from './common/utils.js';
import { GenParameters, GenRequestError, GenRequestErrorType } from './common/generator_parameters.js';
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

export enum TopicIdx {
    TRANSACTIONS = 0,
    TRANSACTION_RESULTS = 1
}
export const TOPICS = [ { name: getEnv("KAFKA_TOPICS_TRANSACTIONS"), size: 64 }, 
                        { name: getEnv("KAFKA_TOPICS_TRANSACTION_RESULTS"), size: 32 }];
const EVENT_SET_SIZE = TOPICS.reduce((a,b) => a + b.size, 0);
export type TransactionEvent = {topic: TopicIdx, event: InKafkaMessage, isPosted: boolean};

class TransactionEventsQueue {
    private events = new PriorityQ<TransactionEvent>((a,b) => a.event.payload.dateTime < b.event.payload.dateTime);
    enqueEvent(event: TransactionEvent) {
        this.events.push(event);
    }
    size(): number {
        return this.events.size();
    }
    dequeEvent(): TransactionEvent | undefined {
        return this.events.pop();
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
const MAX_QUEUE_SIZE = 1024 * 1024 * 100; // 100MB
export class Generator {
    private transactionId = new OverflowingCounter();
    private queue = new TransactionEventsQueue();
    private postedTQueue = new Array<TransactionEvent>();
    private delayGenerator = new DelayGenerator(100);
    private msgMetaDataPerUser = new UserCounters();
    private startTime: number = 0;
    private timeIncrement: number = 0;
    private transactionsToGenerate: number = 0;
    private transactionsGenerated: number = 0;
    private transactionsEnqueued: number = 0;
    private userCount: number = 0;
    private minUserId = new OverflowingCounter();
    private maxUserId = 0;
    private generatedDuringSession: number = 0;
    private stopped = true;
    private queuedSize = 0;
    start(params: GenParameters) {
        this.stop();
        this.stopped = false;
        this.msgMetaDataPerUser.reset(params);
        this.startTime = params.dateFrom;
        this.generatedDuringSession = 0;
        this.transactionsGenerated = 0;
        const endTime = Math.max(params.dateTo, this.startTime);
        this.timeIncrement = (endTime - this.startTime) / Math.max(params.transactionCount, 1);
        this.delayGenerator = new DelayGenerator(params.maxDelayMs??100);
        this.transactionsToGenerate = params.transactionCount;
        this.userCount = params.userCount;
        if (params.minUserId !== undefined) {
            this.minUserId.set(params.minUserId);
        }
        if (params.minTransactionId !== undefined) {
            this.transactionId.set(params.minTransactionId);
        }
    }
    getTransactionIdNext(): number {
        return this.transactionId.value;
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
    postTransaction(params: PostTransactionParams): void {
        if (this.queuedSize + EVENT_SET_SIZE > MAX_QUEUE_SIZE) {
            throw new GenRequestError(`Queue full: ${MAX_QUEUE_SIZE}`, GenRequestErrorType.QUEUE_FULL);
        }
        const now = Date.now();
        const [t,r] = this.makeTransaction(params.userFrom, params.userTo, params.amount,
            params.date, params.date, TResult.CONFIRMED, params.id);
        t.metadata.datePosted = now;
        r.metadata.datePosted = now;
        this.postedTQueue.push({ topic: TopicIdx.TRANSACTIONS, event: t, isPosted: true });
        this.postedTQueue.push({ topic: TopicIdx.TRANSACTION_RESULTS, event: r, isPosted: true });
        this.queuedSize += EVENT_SET_SIZE;
    }
    getEvents(count: number): Array<TransactionEvent> | undefined {
        if (this.stopped && this.postedTQueue.length == 0) {
            return undefined;
        }
        const posted = this.postedTQueue.splice(0, count)
        count -= posted.length;
        if (this.stopped || this.transactionsToGenerate == this.transactionsGenerated && this.queue.size() == 0) {
            this.stopped = true;
            return posted;
        }
        if (this.transactionsEnqueued < count) {
            const toGenerate = Math.min(count, this.transactionsToGenerate - this.transactionsGenerated);
            this.generate(toGenerate);
        }
        for (let i = 0; i < count; i++) {
            const e = this.queue.dequeEvent();
            if (e === undefined) {
                break;
            }
            posted.push(e);
            if (e.topic === TopicIdx.TRANSACTIONS) {
                this.transactionsEnqueued--;
            }
            this.queuedSize -= TOPICS[e.topic].size;
        }
        return posted;
    }
    generatedCount(): number {
        return this.transactionsGenerated;
    }
    getTransactionsToGenerate(): number {
        return this.transactionsToGenerate;
    }
    private makeTransaction(userIdFrom: number, userIdTo: number, amount: number,
        transactionTime: number, datetimeR: number, state: TResult, id?: number): [InKafkaMessage, InKafkaMessage] {
        const transaction: Transaction = {
            id: id ?? this.transactionId.value,
            userIdFrom,
            userIdTo,
            dateTime: transactionTime,
            amount
        }
        this.transactionId.inc();
        const result: TransactionResult = {
            dateTime: datetimeR,
            id: transaction.id,
            state,
        }
        this.msgMetaDataPerUser.maxId = transaction.id;
        this.maxUserId = Math.max(this.maxUserId, userIdFrom, userIdTo);
        this.msgMetaDataPerUser.incrementStat(userIdFrom, amount, transaction.dateTime);
        this.generatedDuringSession+=2; // transaction and result
        if (userIdFrom !== userIdTo) {
            this.msgMetaDataPerUser.incrementStat(userIdTo, amount, transaction.dateTime);
        }
        return [{ payload: transaction, metadata: { } }, { payload:result, metadata: { } }];
    }
    getnUserId(): number {
        return this.minUserId.evalInc(Math.floor(Math.random() * this.userCount));
    }
    generate(count: number) {
        /*  Not going for much realism, where consumers rarely have transactions with other consumers
            Also transaction latency is not emulating any thread contention, so
                transaction result delay will be random.
        */
        const now = Date.now();
        for (let i = this.transactionsGenerated; i < this.transactionsGenerated + count; i++) {
            const transactionTime =  Math.floor(this.startTime + i * this.timeIncrement);
            // Can make internal transfers too (same id to and from)
            const amount = 1 + Math.floor(Math.random() * 1000);
            const [tEvent, rEvent] = this.makeTransaction(this.getnUserId(), this.getnUserId(),
                amount, transactionTime,
                this.delayGenerator.delay(transactionTime),
                TResult.CONFIRMED);
            tEvent.metadata.datePosted = now;
            rEvent.metadata.datePosted = now;
            this.queue.enqueEvent({ topic: TopicIdx.TRANSACTIONS, event: tEvent, isPosted: false });
            this.queue.enqueEvent({ topic: TopicIdx.TRANSACTION_RESULTS, event: rEvent, isPosted: false });
        }
        this.queuedSize += count * EVENT_SET_SIZE;
        this.transactionsGenerated += count;
        this.transactionsEnqueued += count;
    }
    queueSize(): number {
        return this.queue.size();
    }
    postedQueueSize(): number {
        return this.postedTQueue.length;
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