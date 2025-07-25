import { z } from "zod";

export const TransactionValidator = z.object({
    id: z.number(),
    userIdFrom: z.number(),
    userIdTo: z.number(),
    dateTime: z.number(),
    amount: z.number(),
    description: z.string().optional(),
    merchantInfo: z.string().optional(),
    location: z.string().optional()
});

export type Transaction = z.infer<typeof TransactionValidator>;

export enum TResult {
    UNDEFINED = 0, // used to mark that result is not yet processed
    CONFIRMED = 1,
    TIMEOUT = 2,
    FRAUD = 3,
    BLOCKED = 4
}
export const TransactionResultValidator = z.object({
    transactionID: z.number(),
    dateTime: z.number(),
    state: z.nativeEnum(TResult)
});
export type TransactionResult = z.infer<typeof TransactionResultValidator>;