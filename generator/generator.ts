
import { getEnv } from './common/utils.js';
import { GenParameters } from './common/generator_parameters.js';
import { last, PriorityQ } from './common/utils.js'
import { Transaction, TransactionResult, TResult } from './common/event_types.js';



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
export type TransactionEvent = {topic: string, event: Transaction | TransactionResult}

class TransactionEventsQueue {
    // Scheduled transactions will be ordered naturally, but their processing time is random
    // PriorityQueue used to avoid sorting and perform a "merge-sort" like deque.
    private results = new PriorityQ<TransactionResultScheduled>((a, b) => a.dateTime < b.dateTime);
    private transactions = new Array<Transaction>();
    lastTransaction(): Transaction | undefined {
        return last(this.transactions);
    }
    size() {
        return this.transactions.length;
    }

    deque(now: number): Array<TransactionEvent>{
        // Take all transaction and results scheduled before "now"
        let tPos = 0;
        const res = new Array<TransactionEvent>();
        /*  "About while"
            If "transactions" has elements, then "results" will also have them, because:
                1) For every planned event, there will always be a result in "results".
                2) More events are planned then going to be consumed in any single interval
        */
        while (tPos < this.transactions.length && this.transactions[tPos].dateTime < now) {
            if (this.transactions[tPos].dateTime <= this.results.peek()!.dateTime) {
                res.push({ topic: KAFKA_TOPICS_TRANSACTIONS, event: this.transactions[tPos] });
                tPos++;
            } else {
                // Read "About while" for unchecked "pop"
                res.push({ topic: KAFKA_TOPICS_TRANSACTION_RESULTS, event: this.results.pop()!.event() });
            }
        }
        // Check trailing results.
        while (this.results.peek() !== undefined && this.results.peek()!.dateTime < now) {
            res.push({ topic: KAFKA_TOPICS_TRANSACTION_RESULTS, event: this.results.pop()!.event() });
        }
        this.transactions.splice(0, tPos);
        return res;
    }
    enque(transaction: Transaction, result: TransactionResultScheduled) {
        this.transactions.push(transaction);
        this.results.push(result)
    }
}

export class Generator {
    static transactionId = 0;
    static resultTransactionId = 0;
    private queue = new TransactionEventsQueue();
    private currentParams: GenParameters | undefined = undefined;
    private now = 0;
    setParameters(params: GenParameters) {
        // Generation is done under assumption that every second represents 1 day
        // Convert the params.requestIntervalMs to dayTimeMs
        this.currentParams = params;
    }
    getEvents(intervalMs: number): Array<TransactionEvent> {
        const intervalEnd = this.now + intervalMs;

        const lastT = this.queue.lastTransaction();

        if (!lastT || lastT.dateTime < intervalEnd) {
            this.generate(intervalMs * 2, this.now);
        }
        this.now += intervalMs;
        return this.queue.deque(this.now);
    }
    generate(interval: number, now: number) {
        if (this.currentParams == undefined) {
            throw new Error(`Inset generator parameters`)
        }
        /*  Not going for much realism, where consumers rarely have transactions with other consumers
            Also transaction latency is not emulating any thread contention, so 
                transaction result delay will be random.
        */        
        const maxTotalEventsPerSec = this.currentParams.maxTransactionsPerSec * this.currentParams.userCount;
        const maxEventsPerInterval = maxTotalEventsPerSec * interval / 1000 ;
        const eventCount = Math.round(Math.random() * maxEventsPerInterval);
        const timeIncrement = interval / Math.max(1, eventCount);
        console.log(`Generating ${eventCount} events with time increment ${timeIncrement} ms`);
        for (let i = 0; i < eventCount; i++) {
            now += timeIncrement;
            // Can make internal transfers too (same id to and from)
            const userIdFrom = Math.floor(Math.random() * this.currentParams.userCount);
            const userIdTo = Math.floor(Math.random() * this.currentParams.userCount);
            const transaction: Transaction = {
                id: Generator.transactionId++,
                userIdFrom,
                userIdTo,
                dateTime: now,
                amount: Math.random() * 1000
            }
            const scheduledResultTime = now + Math.random() * 100
            const scheduledResult: TransactionResultScheduled = {
                dateTime: scheduledResultTime,
                event: () => { 
                    const state = generateTransactionResult();
                    const res = {
                        dateTime: scheduledResultTime,
                        transactionID: transaction.id,
                        state
                    } as TransactionResult;
                    if (state === TResult.CONFIRMED) {
                        res.resultTransactionId = Generator.resultTransactionId++;
                    }
                    return res;
                }
            }
            this.queue.enque(transaction, scheduledResult);
        }
    }
}
