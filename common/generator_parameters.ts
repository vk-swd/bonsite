import { z } from "zod";

export const GenParametersValidator = z.object({
    userCount: z.number(),
    dateFrom: z.number(),
    dateTo: z.number(),
    transactionCount: z.number(),
    maxDelayMs: z.number().optional(),
    minUserId: z.number().optional()
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
        public transactionCount: number = 0,
        public seqNumber: number = 0,
        public transactionResultCounter: number = 0,
    ) {}
}
export class UserCounters {
    data = new Map<number, Counters>();
    serialise(): string {
        return JSON.stringify(Array.from(this.data.entries()).map(([userId, counters]) => [userId, counters.transactionCount]));
    }
    static deserialise(data: string): UserCounters {
        const instance = new UserCounters();
        instance.data = new Map<number, Counters>(JSON.parse(data).map(([userId, transactionCount]: [number, number]) => [userId, new Counters(transactionCount)]));
        return instance;
    }
    reset(): void {
        this.data.clear();
    }
    get(userId: number): Counters {
        if (!this.data.has(userId)) {
            this.data.set(userId, new Counters());
        }
        return this.data.get(userId)!;
    }
}
