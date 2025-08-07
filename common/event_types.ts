import { z } from "zod";

export const TransactionValidator = z.object({
    id: z.number(),
    dateTime: z.number(),
    amount: z.number(),
    userIdFrom: z.number(),
    userIdTo: z.number(),
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
    id: z.number(),
    dateTime: z.number(),
    state: z.nativeEnum(TResult)
});
export type TransactionResult = z.infer<typeof TransactionResultValidator>;

export const MetadataValidator = z.object({
    seqNumber: z.number(),
    isIgnored: z.boolean()
})
export const MetadataWrapperValidator = z.object({
    metadata: MetadataValidator,
    payload: z.union([
        TransactionValidator,TransactionResultValidator])
});
export type InKafkaMessage = z.infer<typeof MetadataWrapperValidator>;
export type Metadata = z.infer<typeof MetadataValidator>;
export type TransactionMessages = { type: "t", r: InKafkaMessage[] } | { type: "r", r: InKafkaMessage[] } | { type: "e", r: string[] }
