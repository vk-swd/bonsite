import { date, z } from "zod";
import { getEnum, getEnumOptional, getInt as getNumber, getIntOptional as getNumberOptional, getString } from "./zodGqlTypes.js";

const IdValidator = getNumber();
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
    state: z.nativeEnum(TResult)
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
    state: z.nativeEnum(TResult).optional()
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

export const UserDataValidator = z.object({
    cursor: IdValidator,
    name: getString() //edge?
});
export const UserDataValidatorList = z.array(UserDataValidator);
export type UserDataList = z.infer<typeof UserDataValidatorList>;

export const UserDataRequestValidator = z.object({
    cursor: IdValidator,
    count: getNumber(),
    name: getString()
});
export type UserDataRequest = z.infer<typeof UserDataRequestValidator>;

export const reqStatementUrl = "statements"
export const reqUsersUrl = "users"
export const postTransactionsUrl = "postT"
export const MIN_DATE = "1970-01-01T00:00:00.000Z";
export const MAX_DATE = "9999-12-31T23:59:59.997Z";
export enum StatementType {
    FS = 1, // full statement
    DS = 2  // delta statement
}
export const StatementParametersValidatorGql = z.object({
    userId: getString(),
    fromm: getString(),
    too: getString(),
    type: getEnumOptional(StatementType, "Int")
});
export type StatementParametersGql = z.infer<typeof StatementParametersValidatorGql>;

export const StatementParametersValidator = z.object({
    userId: getNumber(),
    fromm: getNumberOptional(),
    too: getNumberOptional(),
    type: getEnumOptional(StatementType, "Int")
});
export type StatementParameters = z.infer<typeof StatementParametersValidator>;