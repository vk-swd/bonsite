import { z } from "zod";
import { getEnum, getInt as getNumber, getIntOptional as getNumberOptional, getString } from "./zodGqlTypes.js";


export const GenParametersValidatorGql = z.object({
    userCount: getString(),
    dateFrom: getString(),
    dateTo: getString(),
    transactionCount: getString(),
    maxDelayMs: getString(),
    minUserId: getString(),
    minTransactionId: getString()
});
export type GenParametersGql = z.infer<typeof GenParametersValidatorGql>;

export const GenParametersValidator = z.object({
    userCount: getNumber(),
    dateFrom: getNumber(),
    dateTo: getNumber(),
    transactionCount: getNumber(),
    maxDelayMs: getNumberOptional(),
    minUserId: getNumberOptional(),
    minTransactionId: getNumberOptional()
});

export type GenParameters = z.infer<typeof GenParametersValidator>;

export const PostTransactionValidatorGql = z.object({
    userFrom: getString(),
    userTo: getString(),
    amount: getString(),
    date: getString()
});
export type PostTransactionParamsGql = z.infer<typeof PostTransactionValidatorGql>;

export const PostTransactionValidator = z.object({
    userFrom: getNumber(),
    userTo: getNumber(),
    amount: getNumber(),
    date: getNumber()
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
    totalSent: getNumber(),
    isRunning: getEnum(GenerationState, "Int"),
    percentComplete: getNumber(),
    maxUserId: getNumber(),
    maxTransactionId: getNumber(),
    generated: getNumber()
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
    incrementStat(userId: number, amount: number, date: number) {
        const c = this.get(userId);
        c.transactionCount++;
        c.amountSum += amount;
        c.updateMinDate(date);
        c.updateMaxDate(date);
    }
}
