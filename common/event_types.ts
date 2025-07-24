export type Transaction = {
    id: number,
    userIdFrom: number,
    userIdTo: number,
    dateTime: number,
    amount: number,
    description?: string,
    merchantInfo?: string,
    location?: string,
}

export enum TResult {
    UNDEFINED = -1, // used to mark that result is not yet processed
    CONFIRMED = 0,
    TIMEOUT = 1,
    FRAUD = 2,
    BLOCKED = 3
}

export type TransactionResult = {
    transactionID: number,
    dateTime: number,
    state: TResult
}