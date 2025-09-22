import * as fsp from 'fs/promises';
import { InKafkaMessage, StatementParameters, StatementType } from "./common/event_types.js";
import { Deferred, getEnv } from './common/utils.js';
import { UserConnection } from "./common/db/db_defines.js";
import { Writer } from './writer.js';
import { metrics, updateMaxResponseDelayMs } from './monitoring_local.js';
import { logger } from './common/logger.js';
import { last } from './common/utils.js';

const SHARED_DIR = getEnv('SHARED_DIR');

const TASK_DELAY_REPORT_INTERVAL_MS = 5000;
const ABORT_INTERVAL_MS = 60000;


export interface Worker<O> {
    deferred: Deferred<O>;
    creationTime: number;
    get created(): number
    handle(t: InKafkaMessage): void;
    finish(): Promise<void>;
    cancel(why:string): void;
    test(): string
    get result(): Promise<O>;
    get done(): boolean;
}
export class BaseWorker<O> implements Worker<O> {
    deferred = new Deferred<O>();
    creationTime = Date.now();
    get created() {
        return this.creationTime;
    }
    test(): string {
        return "test";
    }
    handle(_: InKafkaMessage): void {}
    finish(): Promise<void> {
        throw new Error("Method 'finish' not implemented.");
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
export class Serialiser extends BaseWorker<string[]> implements Worker<string[]> {
    rresult: string[] = [];
    finished = false;
    offsetCounter = 0;
    constructor(private params: StatementParameters) {
        super();
    }
    test(): string {
        return "Serialiser";
    }
    finish(): Promise<void> {
        if (this.finished) {
            return Promise.resolve();
        }
        this.finished = true;
        metrics?.servedStatementsCount.inc();
        metrics?.servedTransactionRecords.inc(this.rresult.length);
        updateMaxResponseDelayMs(Date.now() - this.creationTime);
        this.deferred.resolve(this.rresult);
        return Promise.resolve();
    }
    handle(t: InKafkaMessage): void {
        if (!this.params.count) {
            this.rresult.push(JSON.stringify(t));
            return;
        }
        if (this.rresult.length >= this.params.count) {
            return;
        }
        if (!this.params.offset) {
            this.rresult.push(JSON.stringify(t));
            return;
        }
        if (this.params.offset > this.offsetCounter) {
            this.offsetCounter++;
            return;
        }
        this.rresult.push(JSON.stringify(t));
    }
}
export class FileWriter extends BaseWorker<string[]> implements Worker<string[]> {
    writer: Writer;
    finished = false;
    constructor(private fileName: string, private p : StatementParameters, baseDir: string = SHARED_DIR) {
        super();
        this.writer = new Writer(baseDir + '/' + fileName);
    }
    handle(t: InKafkaMessage): void {
        this.writer.addMessage(JSON.stringify(t));
    }
    test(): string {
        return "FileWriter";
    }
    finish(): Promise<void> {
        if (this.finished) {
            return Promise.resolve();
        }
        this.finished = true;
        return this.writer.flushAndStop().then(async (lineCount) => {
            metrics?.filesGenerated.inc();
            metrics?.servedStatementsCount.inc();
            metrics?.servedTransactionRecords.inc(lineCount);
            updateMaxResponseDelayMs(Date.now() - this.creationTime);
            this.deferred.resolve([this.fileName]);
        }).catch(e => {
            metrics?.fileWriteErrors.inc();
            this.deferred.reject(e);
        })
    }
    cancel(reason?: any): void {
        this.writer.abort().then(() => {
            this.deferred.reject(reason);
        }).catch(e => {
            this.deferred.reject(`Error aborting file write ${this.fileName} : ${e}`);
        });
    }
}

export class BundleHandler<O> {
    waitingList: {user: number, task: Worker<O>, param: StatementParameters}[] = [];
    statementParams: StatementParameters[] = [];
    bundleTimer: NodeJS.Timeout | undefined = undefined;
    inFlightResuests = 0;
    taskDelayReportTO: NodeJS.Timeout;
    constructor(private maxInFlight: number, // consider making this dynamic
                private db_connection: UserConnection,
                private workerFactory: (p:StatementParameters) => Worker<O>){
        const report = new Map<number, {val: number}>();
        this.taskDelayReportTO = setTimeout(() => {
            const now = Date.now();
            const divisor = TASK_DELAY_REPORT_INTERVAL_MS;
            this.waitingList.forEach(w => {
                const elapsed = now - w.task.created;
                const hystoBlock = elapsed - (elapsed % divisor);
                const key = hystoBlock
                if (!report.has(key)) {
                    report.set(key, {val: 1});
                } else {
                    report.get(key)!.val++;
                }
            })
            let reportStr = "";
            report.forEach((v,k) => {
                if (k == 0) {
                    return;
                }
                if (reportStr.length) {
                    reportStr += ", ";
                }
                reportStr += `${k}:${v.val}`;
            })
            if (reportStr.length) {
                logger.warn(`There are ${this.waitingList.length} waiting tasks. Delayed tasks by age (ms): ${reportStr}`);
            }
            if (!this.stopped) {
                this.taskDelayReportTO.refresh();
            }
            report.clear();
        }, TASK_DELAY_REPORT_INTERVAL_MS);
    }
    addTask(p: StatementParameters): Promise<O> {
        const task: Worker<O> = this.workerFactory(p);
        this.waitingList.push({user: p.userId, task, param: p});
        this.statementParams.push(p);
        if (!this.bundleTimer) {
            this.start();
        }
        return task.result;
    }
    stopped = false;
    stop() {
        this.stopped = true;
        clearTimeout(this.bundleTimer!);
        clearTimeout(this.taskDelayReportTO);
    }
    start() {
        if (this.bundleTimer || this.stopped) {
            return;
        }
        // TODO: A balanced task bundling to minimize latency and maximize throughput
        this.bundleTimer = setTimeout(async () => {
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
            const tasks = this.waitingList.splice(0, toProcess);
            this.inFlightResuests += toProcess;
            let lastReqId: number | undefined = undefined;
            metrics?.databaseRequests.inc();
            // Can't await - async error handling is inside streamTransactions
            this.db_connection!.streamTransactions(tasks.map(t => t.param), async (user: number, reqId: number, line: InKafkaMessage) => {
                /* reqId - index for "tasks" bundle / identifier for the statement request parameters
                    Transactions are expected to come in the order of request parameters:
                    [reqId1, user1, from1, to1], [reqId2, user2, from2, to2] .... =>
                    [t11, t12,..., t1n], [t21, t22,..., t2m] ....
                    All transactions in 1 bundle carry the "reqId" = 1, and in another - "reqId" = 2, etc...
                */
                if (reqId >= tasks.length || tasks[reqId].user !== user
                    || ((lastReqId !== undefined) && (reqId < lastReqId))) {
                    throw `Unexpected output in a transactions request.
                    reqId: ${reqId}, user: ${user},
                    lastReqId ${lastReqId}, ${lastReqId ? `last user ${tasks[lastReqId].user}` : ``}
                    Ignoring ${tasks.length} tasks from ${tasks[0].user} to ${last(tasks)?.user}.`
                }
                if (lastReqId === undefined) {
                    // If transactions started not from the first task.
                    lastReqId = reqId;
                    for (let i = 0; i < lastReqId; i++) {
                        tasks[i].task.finish().then(() => {
                            this.inFlightResuests--;
                        });
                    }
                } else if (lastReqId !== reqId) {
                    // Some users may be skipped if dates didn't include any transactions
                    // listIdx < params.length && params[listIdx].userId != user; listIdx++)
                    for (let i = lastReqId; i < reqId; i++ ) {
                        tasks[i].task.finish().then(() => {
                            this.inFlightResuests--;
                        });
                    }
                    lastReqId = reqId;
                }
                tasks[lastReqId].task.handle(line);
            })
            .then(() => {
                if (lastReqId == undefined) {
                    // In case if no transactions were returned for any user
                    lastReqId = 0;
                }
                for (; lastReqId < tasks.length; lastReqId++) {
                    tasks[lastReqId].task.finish().then(() => {
                        this.inFlightResuests--;
                    });
                }
            })
            .catch(e => {
                metrics?.databaseRequestErrors.inc();
                if (lastReqId !== undefined) {
                    for (let i = lastReqId; i < tasks.length; i++) {
                        // TODO: make a more explicit error state
                        tasks[i].task.cancel(`Error processing user ${tasks[i].user} : ${e}`);
                        this.inFlightResuests--;
                    }
                }
            }).finally(() => {
                if (!this.stopped) {
                    this.bundleTimer!.refresh();
                }
            })
        }, 100);
    }
}

export class Preparer extends BundleHandler<string[]> {
    salt = 0;
    constructor(db_connection: UserConnection, maxInFlight: number = 100000) {
        super(maxInFlight, db_connection, (p: StatementParameters) => {
            if ((p.type ?? StatementType.FS) === StatementType.FS) {
                const fileName = `statement-${p.userId}-${p.fromm}-${p.too}-${new Date().toISOString()}-${this.salt++}.json`;
                return new FileWriter(fileName, p);
            } else {
                return new Serialiser(p);
            }
        });
    }
}