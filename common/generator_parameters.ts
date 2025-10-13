import { z } from "zod";
import { StatementParameters } from "./event_types";

export const GenParametersValidator = z.object({
    userCount: z.number(),
    dateFrom: z.number(),
    dateTo: z.number(),
    transactionCount: z.number(),
    maxDelayMs: z.number().optional(),
    minUserId: z.number().optional(),
    minTransactionId: z.number().optional()
})
export type GenParameters = z.infer<typeof GenParametersValidator>;

export const PostTransactionValidator = z.object({
    id: z.number().optional(),
    userFrom: z.number(),
    userTo: z.number(),
    amount: z.number(),
    date: z.number()
});
export type PostTransactionParams = z.infer<typeof PostTransactionValidator>;

export const startUrl = "start"
export const stopUrl = "stop"
export const progressUrl = "progress"
export const getStatUrl = "getstat"

export enum GenerationState {
    RUNNING = 1,
    STOPPED = 2
}
export const ProgressReportValidator = z.object({
    postedPending: z.number(),
    totalSent: z.number(),
    isRunning: z.enum(GenerationState),
    percentComplete: z.number(),
    maxUserId: z.number(),
    maxTransactionId: z.number(),
    generated: z.number()
});
export type ProgressReport = z.infer<typeof ProgressReportValidator>;

const MAGIC_UNDEFINED = -1;
export class Counters {
    constructor(
        public userId: number = 0,
        public amountSum: number = 0,
        public transactionCount: number = 0,
        public minDate: number | undefined = undefined,
        public maxDate: number | undefined = undefined
    ) {}
    updateMinDate(date: number) {
        if (this.minDate === undefined || date < this.minDate) {
            this.minDate = date;
        }
    }
    updateMaxDate(date: number) {
        if (this.maxDate === undefined || date > this.maxDate) {
            this.maxDate = date;
        }
    }
    serialise(): string {
        return [this.userId, Math.floor(this.amountSum),
            this.transactionCount,
            this.minDate??MAGIC_UNDEFINED, this.maxDate??MAGIC_UNDEFINED].join(",");
    }
    static deserialise(data: string): Counters {
        const parts = data.split(",");
        return new Counters(
            parseInt(parts[0]),
            parseInt(parts[1]),
            parseInt(parts[2]),
            parts[3] == `${MAGIC_UNDEFINED}` ? undefined : parseInt(parts[3]),
            parts[4] == `${MAGIC_UNDEFINED}` ? undefined : parseInt(parts[4])
        );
    }
}
export class UserCounters {
    data = new Map<number, Counters>();
    params: GenParameters | undefined;
    maxId: number = 0;
    serialise(): string {
        return `${this.maxId}\n` + Array.from(this.data.values()).map((c => c.serialise())).join(',\n');
    }
    reset(params: GenParameters): void {
        this.data.clear();
        this.params = params;
    }
    get(userId: number): Counters {
        if (!this.data.has(userId)) {
            this.data.set(userId, new Counters(userId));
        }
        return this.data.get(userId)!;
    }
    incrementStat(userId: number, amount: number, date: number) {
        const c = this.get(userId);
        c.transactionCount++;
        c.amountSum += amount;
        c.updateMinDate(date);
        c.updateMaxDate(date);
    }
}

export enum GenRequestErrorType {
    INVALID_PARAMS = "Invalid parameters",
    QUEUE_FULL = "Generator queue is full",
    KAFKA_FULL = "Kafka queue is full",
    GENERATOR_BUSY = "Generator is busy",
    GENERATOR_NOT_RUNNING = "Generator is not running",
    STAT_REQUEST_ERROR = "Error getting statistics",
    INTERNAL_ERROR = "Internal error"
}
export class GenRequestError extends Error {
    constructor(public message: string, public type: GenRequestErrorType) {
        super(message);
        this.name = "GenRequestError";
    }
    toString() {
        return JSON.stringify({stack: this.stack, error: this.name, message: this.message, type: this.type});
    }
}
