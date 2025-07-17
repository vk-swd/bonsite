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
    CONFIRMED = 0,
    TIMEOUT = 1,
    FRAUD = 2,
    BLOCKED = 3
}

export type TransactionResult = {
    transactionID: number,
    resultTransactionId?: number, // confirmed transaction by ledger
    dateTime: number,
    state: TResult
}