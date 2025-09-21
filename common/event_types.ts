import z from "zod";

const IdValidator = z.number();
export const TransactionValidator = z.object({
    id: IdValidator,
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
    id: IdValidator,
    dateTime: z.number(),
    state: z.enum(TResult)
});
export type TransactionResult = z.infer<typeof TransactionResultValidator>;

const DatePtrValidator = z.object({
    userId: IdValidator,
    dateBefore: z.number().optional(),
    dateAfter: z.number().optional()
});
export const MetadataValidator = z.object({
    dateTime: z.number().optional(),
    userDatePtrs: z.array(DatePtrValidator).optional(),
    state: z.enum(TResult).optional()
})
export const MetadataWrapperValidator = z.object({
    metadata: MetadataValidator,
    payload: z.union([
        TransactionValidator,TransactionResultValidator])
});
export type InKafkaMessage = z.infer<typeof MetadataWrapperValidator>;
export type Metadata = z.infer<typeof MetadataValidator>;
export type TransactionMessages = { type: "t", r: InKafkaMessage[] } | { type: "r", r: InKafkaMessage[] } | { type: "e", r: string[] }

export const OffsetValidator = z.object({
    groupId: z.string(),
    topic: z.string(),
    partition: z.number(),
    offset: z.string()
})
export type Offset = z.infer<typeof OffsetValidator>;


export const UserDataRequestValidator = z.object({
    cursor: z.number().optional(),
    count: z.number(),
    pattern: z.string()
}).register(z.globalRegistry, { description: "UserDataRequest" });
export type UserDataRequestParameters = z.infer<typeof UserDataRequestValidator>
export const UserDataValidator = z.object({
    cursor: z.number(),
    name: z.string(),
    id: z.number()
}).register(z.globalRegistry, { description: "UserData" });
export type UserData = z.infer<typeof UserDataValidator>;
export const UserDataResultValidator = z.object({
    slice: UserDataValidator.array(),
    totalCount: z.number()
}).register(z.globalRegistry, { description: "UserDataResult" });
export type UserDataResult = z.infer<typeof UserDataResultValidator>;



export const reqStatementUrl = "statements"
export const reqUsersUrl = "users"
export const postTransactionsUrl = "postT"
export const MIN_DATE = "1970-01-01T00:00:00.000Z";
export const MAX_DATE = "9999-12-31T23:59:59.997Z";
export enum StatementType {
    FS = 1, // full statement
    DS = 2  // delta statement
}
export const StatementParametersValidator = z.object({
    userId: z.number(),
    fromm: z.number().optional(),
    too: z.number().optional(),
    type: z.enum(StatementType),
    offset: z.number().optional(),
    count: z.number().optional()
}).register(z.globalRegistry, { description: "StatementParameters" });
export type StatementParameters = z.infer<typeof StatementParametersValidator>;