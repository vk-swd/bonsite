import { z } from "zod";

export const GenParametersValidator = z.object({
    userCount: z.number(),
    maxTransactionsPerDay: z.number(),
    generationIntervalMs: z.number()
});

export type GenParameters = z.infer<typeof GenParametersValidator>;

export const startUrl = "/start"
export const stoptUrl = "/stop"