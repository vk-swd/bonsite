import * as fsp from 'fs/promises';
import { InKafkaMessage, StatementParameters, StatementType } from "./common/event_types.js";
import { Deferred, getEnv } from './common/utils.js';
import { UserConnection } from "./common/db/db_defines.js";
import { Writer } from './writer.js';

let requestCount = 0;
const SHARED_DIR = getEnv('SHARED_DIR');

const ABORT_CHECK_MIN_INTERVAL_MS = 1000;
const ABORT_INTERVAL_MS = 60000;


interface Worker<O> {
    deferred: Deferred<O>;
    work(input: InKafkaMessage[]): Promise<O>;
    cancel(why:string): void;
    get result(): Promise<O>;
    get done(): boolean;
}
export class BaseWorker<O> implements Worker<O> {
    deferred = new Deferred<O>();
    work(lines: InKafkaMessage[]): Promise<O> {
        throw new Error("Method not implemented.");
    }
    get result() {
        return this.deferred.promise;
    }
    cancel(reason?: any) {
        this.deferred.reject(reason);
    }
    get done() {
        return false;
    }
}
export class Serialiser extends BaseWorker<string[]> {
    deferred = new Deferred<string[]>();
    constructor() {
        super();
    }
    work(lines: InKafkaMessage[]): Promise<string[]> {
        this.deferred.resolve(lines.map(l => JSON.stringify(l)));
        return this.deferred.promise;
    }
}
export class FileWriter extends BaseWorker<string[]> {
    deferred = new Deferred<string[]>();
    writer: Writer;
    constructor(private fileName: string) {
        super();
        this.writer = new Writer(fileName);
    }
    work(lines: InKafkaMessage[]): Promise<string[]> {
        lines.forEach(l => this.writer.addMessage(JSON.stringify(l)));
        this.writer.flushAndStop().then(() => {
            this.deferred.resolve([this.fileName]);
        }).catch(e => {
            this.deferred.reject(e);
        });
        return this.deferred.promise;
    }
}

export class BundleHandler<O> {
    waitingList: Worker<O>[] = [];
    statementParams: StatementParameters[] = [];
    bundleTimer: NodeJS.Timeout | undefined = undefined;
    inFlightResuests = 0;
    constructor(private maxInFlight: number, // consider making this dynamic
                private db_connection: UserConnection,
                private workerFactory: (p:StatementParameters) => Worker<O>){
    }
    addTask(p: StatementParameters): Promise<O> {
        const task: Worker<O> = this.workerFactory(p);
        this.waitingList.push(task as Worker<O>);
        this.statementParams.push(p);
        if (!this.bundleTimer) {
            this.start();
        }
        return task.result;
    }
    start() {
        if (this.bundleTimer) {
            return;
        }
        this.bundleTimer = setTimeout(async () => {
            // TODO: track max delay between runs and number of processed records
            // process all waiting tasks in a bundle
            if (!this.bundleTimer) {
                return;
            }
            if (this.waitingList.length === 0) {
                this.bundleTimer.refresh();
                return;
            }
            const toProcess = Math.min(this.maxInFlight - this.inFlightResuests, this.waitingList.length);
            if (toProcess === 0) {
                this.bundleTimer.refresh();
                return;
            }
            // TODO: consider resolving tasks and params in chunks
            const tasks = this.waitingList.splice(0, toProcess);
            const params = this.statementParams.splice(0, toProcess);
            this.inFlightResuests += toProcess;
            let currentResult: InKafkaMessage[] = [];
            let listIdx: number | undefined = undefined;
            try {
                await this.db_connection!.getTransactions(params, async (user: number, line: InKafkaMessage) => {
                    if (listIdx === undefined) {
                        listIdx = 0;
                        for (; listIdx < params.length
                                && params[listIdx].userId !== user; listIdx++) {
                            tasks[listIdx].work([]);
                        }
                    } else if (listIdx >= params.length) {
                        // all users processed, but db returned more - stopr request but dont reject all
                        throw new Error(`Received transaction for user ${user} after all ${params.length} users were processed`);
                    } else if (user !== params[listIdx].userId) {
                        tasks[listIdx].work(currentResult);
                        listIdx++;
                        currentResult = [];
                        // Some users may be skipped if dates didn't include any transactions
                        for (;listIdx < params.length && params[listIdx].userId != user; listIdx++) {
                            tasks[listIdx].work([]);
                        }
                    }
                    currentResult.push(line);
                })
            } catch(e) {
                if (listIdx !== undefined) {
                    for (let i = listIdx; i < tasks.length; i++) {
                        tasks[i].cancel(`Error processing user ${params[i].userId} : ${e}`);
                    }
                    listIdx = undefined;
                }
            }
            if (listIdx !== undefined) {
                for (; listIdx < tasks.length; listIdx++) {
                    tasks[listIdx].work(currentResult);
                    currentResult = [];
                }
            }
            await Promise.all(tasks.map(t => t.result.catch(_ => {}).finally(() => {
                this.inFlightResuests--;
            })));
            this.bundleTimer.refresh();
        }, 1000);
    }
}

export class Preparer extends BundleHandler<string[]> {
    constructor(db_connection: UserConnection, maxInFlight: number = 100000) {
        super(maxInFlight, db_connection, (p: StatementParameters) => {
            if ((p.type ?? StatementType.FS) === StatementType.FS) {
                const fileName = `statement-${p.userId}-${new Date().toISOString()}.json`;
                return new FileWriter(SHARED_DIR + "/" + fileName);
            } else {
                return new Serialiser();
            }
        });
    }
}