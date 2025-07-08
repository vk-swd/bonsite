import { z } from "zod";

export const GenParametersValidator = z.object({
    userCount: z.number(),
    maxTransactionsPerSec: z.number(),
    generationIntervalMs: z.number()
});

export type GenParameters = z.infer<typeof GenParametersValidator>;

export const startUrl = "/start"
export const stoptUrl = "/stop"