import { z } from "zod";

export const GenParametersValidator = z.object({
    userCount: z.number(),
    dateFrom: z.number(),
    dateTo: z.number(),
    transactionCount: z.number(),
    maxDelayMs: z.number().optional(),
    minUserId: z.number().optional(),
    minTransactionId: z.number().optional()
});

export type GenParameters = z.infer<typeof GenParametersValidator>;

export const startUrl = "start"
export const stopUrl = "stop"
export const progressUrl = "progress"
export const getStatUrl = "getstat"

export enum RequestStatus {
    OK = 200,
    ERROR = 500,
}
export const RequestResultValidator = z.object({
    status: z.nativeEnum(RequestStatus),
    message: z.string(),
    data: z.union([z.null(), z.string()]).optional(),
});
export type RequestResult = z.infer<typeof RequestResultValidator>;

export enum GenerationState {
    RUNNING = 1,
    STOPPED = 2
}

export const ProgressReportValidator = z.object({
    totalSent: z.number(),
    isRunning: z.nativeEnum(GenerationState),
    percentComplete: z.number()
});
export type ProgressReport = z.infer<typeof ProgressReportValidator>;

export class Counters {
    constructor(
        public userId: number = 0,
        public amountSum: number = 0,
        public transactionCount: number = 0,
        public transactionSeqNumber: number = 0,
        public transactionResultSeqNumber: number = 0,
        public minDate: number = Number.MAX_SAFE_INTEGER,
        public maxDate: number = 0
    ) {}
    serialise(): string {
        return [this.userId, Math.floor(this.amountSum), this.transactionCount, this.transactionSeqNumber, this.transactionResultSeqNumber, this.minDate, this.maxDate].join(",");
    }
    static deserialise(data: string): Counters {
        const parts = data.split(",");
        return new Counters(
            parseInt(parts[0]),
            parseInt(parts[1]),
            parseInt(parts[2]),
            parseInt(parts[3]),
            parseInt(parts[4]),
            parseInt(parts[5]),
            parseInt(parts[6])
        );
    }
}
export class UserCounters {
    data = new Map<number, Counters>();
    serialise(): string {
        return Array.from(this.data.values()).map((c => c.serialise())).join(',\n');
    }
    reset(): void {
        this.data.clear();
    }
    get(userId: number): Counters {
        if (!this.data.has(userId)) {
            this.data.set(userId, new Counters(userId));
        }
        return this.data.get(userId)!;
    }
}
