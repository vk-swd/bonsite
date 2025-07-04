
import { last, PriorityQ } from './common/utils.js'
import { GenParameters } from './api.js';




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
export type TransactionEvent = {type: "transaction", event: Transaction} | {type: "result", event: TransactionResult}
class TransactionEventsQueue {
    // Scheduled transactions will be ordered naturally, but their processing time is random
    // PriorityQueue used to avoid sorting and perform a "merge-sort" like deque.
    private results = new PriorityQ<TransactionResult>((a, b) => a.dateTime < b.dateTime);
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
                res.push({ type: "transaction", event: this.transactions[tPos] });
                tPos++;
            } else {
                // Read "About while" for unchecked "pop"
                res.push({ type: "result", event: this.results.pop()! });
            }
        }
        // Check trailing results.
        while (this.results.peek() !== undefined && this.results.peek()!.dateTime < now) {
            res.push({ type: "result", event: this.results.pop()! });
        }
        this.transactions.splice(0, tPos);
        return res;
    }
    enque(transaction: Transaction, result: TransactionResult) {
        this.transactions.push(transaction);
        this.results.push(result)
    }
}

const msPerDay = 1000 * 60 * 60 * 24;
export class Generator {
    static transactionId = 0;
    private queue = new TransactionEventsQueue();
    private currentParams: GenParameters | undefined = undefined;
    private now = 0;
    private intervalMs = 0;
    setParameters(params: GenParameters) {
        // Generation is done under assumption that every second represents 1 day
        // Convert the params.requestIntervalMs to dayTimeMs
        this.intervalMs = params.generationIntervalMs * msPerDay / 1000;
        this.currentParams = params;
    }
    getEvents(): Array<TransactionEvent> {
        const intervalEnd = this.now + this.intervalMs;

        const lastT = this.queue.lastTransaction();

        if (!lastT || lastT.dateTime < intervalEnd) {
            this.generate(this.intervalMs * 2, this.now);
        }
        this.now += this.intervalMs;
        return this.queue.deque(this.intervalMs);
    }
    generate(interval: number, timeMs: number) {
        if (this.currentParams == undefined) {
            throw new Error(`Inset generator parameters`)
        }
        /*  Not going for much realism, where consumers rarely have transactions with other consumers
            Also transaction latency is not emulating any thread contention, so 
                transaction result delay will be random.
        */        
        const maxTotalEventsPerDay = this.currentParams.maxTransactionsPerDay * this.currentParams.userCount;
        const maxEventsPerInterval = maxTotalEventsPerDay * interval / msPerDay ;
        const eventCount = Math.random() * maxEventsPerInterval;
        const timeIncrement = interval / eventCount;
        
        for (let i = 0; i < eventCount; i++) {
            timeMs += timeIncrement;
            // Can make internal transfers too (same id to and from)
            const userIdFrom = Math.floor(Math.random() * this.currentParams.userCount);
            const userIdTo = Math.floor(Math.random() * this.currentParams.userCount);
            const transaction: Transaction = {
                id: Generator.transactionId++,
                userIdFrom,
                userIdTo,
                dateTime: timeMs,
                amount: Math.random() * 1000
            }
            const result = {
                dateTime: timeMs + Math.random() * 100,
                transactionID: transaction.id,
                state: generateTransactionResult()
            }
            this.queue.enque(transaction, result);
        }
    }
}
