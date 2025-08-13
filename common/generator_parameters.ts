import { z } from "zod";

export const GenParametersValidator = z.object({
    userCount: z.number(),
    maxTransactionsPerSec: z.number(),
    generationIntervalMs: z.number(),
    maxDelayMs: z.number().optional(),
    transactionCount: z.number().optional(),
});

export type GenParameters = z.infer<typeof GenParametersValidator>;

export const startUrl = "start"
export const stoptUrl = "stop"
export const progressUrl = "progress"

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
    totalUsers: z.number(),
    isRunning: z.nativeEnum(GenerationState),
    percentComplete: z.number()
});
export type ProgressReport = z.infer<typeof ProgressReportValidator>;