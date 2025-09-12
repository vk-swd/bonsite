import * as fsp from 'fs/promises';
import { InKafkaMessage, StatementParameters, StatementType } from "./common/event_types.js";
import { Deferred, getEnv } from './common/utils.js';
import { UserConnection } from "./common/db/db_defines.js";
import { Writer } from './writer.js';
import { metrics, updateMaxResponseDelayMs } from './monitoring_local.js';
import { logger } from './common/logger.js';
import { last } from './common/utils.js';

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
    creationTime = Date.now();
    constructor() {
        super();
    }
    work(lines: InKafkaMessage[]): Promise<string[]> {
        this.deferred.resolve(lines.map(l => JSON.stringify(l)));
        metrics?.servedStatementsCount.inc();
        metrics?.servedTransactionRecords.inc(lines.length);
        updateMaxResponseDelayMs(Date.now() - this.creationTime);
        return this.deferred.promise;
    }
}
export class FileWriter extends BaseWorker<string[]> {
    deferred = new Deferred<string[]>();
    writer: Writer;
    creationTime = Date.now();
    constructor(private fileName: string, private p : StatementParameters, baseDir: string = SHARED_DIR) {
        super();
        this.writer = new Writer(baseDir + '/' + fileName);
        this.timeout = setTimeout(() => this.trackTime(), 5000);
    }
    timeout: NodeJS.Timeout | undefined = undefined;
    trackTime() {
        logger.warn(`Task hanging for to long ${JSON.stringify(this.p)} filename ${this.fileName}`);
        clearTimeout(this.timeout);
        this.timeout = setTimeout(() => this.trackTime(), 5000);
    }
    work(lines: InKafkaMessage[]): Promise<string[]> {
        //TODO: for 0 lines return empty file name array
        //TODOTODO: make a more informative result structure
        lines.forEach(l => this.writer.addMessage(JSON.stringify(l)));
        this.writer.flushAndStop().then(async () => {
            metrics?.filesGenerated.inc();
            metrics?.servedStatementsCount.inc();
            metrics?.servedTransactionRecords.inc(lines.length);
            updateMaxResponseDelayMs(Date.now() - this.creationTime);
            this.deferred.resolve([this.fileName]);
        }).catch(e => {
            metrics?.fileWriteErrors.inc();
            this.deferred.reject(e);
        }).finally(() => {
            if (this.timeout) {
                clearTimeout(this.timeout);
                this.timeout = undefined;
            }
        });
        return this.deferred.promise;
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
    constructor(private maxInFlight: number, // consider making this dynamic
                private db_connection: UserConnection,
                private workerFactory: (p:StatementParameters) => Worker<O>){
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
    start() {
        if (this.bundleTimer) {
            return;
        }
        // TODO: A balanced task bundling to minimize latency and maximize throughput
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
            this.inFlightResuests += toProcess;
            let currentResult: [InKafkaMessage,number][] = [];
            let lastReqId: number | undefined = undefined;
            try {
                metrics?.databaseRequests.inc();
                await this.db_connection!.getTransactions(tasks.map(t => t.param), async (user: number, reqId: number, line: InKafkaMessage) => {
                    /* An assumprion here that "db_connection.getTransactions" will asssign
                        "idx" column to the parameter locatein in the "params" array
                        That's why the "params" index - listIdx - is used as request identifier
                    */
                    if (reqId > tasks.length || tasks[reqId].user !== user 
                        || ((lastReqId !== undefined) && (reqId < lastReqId))) {
                        throw `Unexpected output in a transactions request.
                        reqId: ${reqId}, user: ${user}, 
                        lastReqId ${lastReqId}, ${lastReqId ? `last user ${tasks[lastReqId].user}` : ``}
                        Ignoring ${tasks.length} tasks from ${tasks[0].user} to ${last(tasks)?.user}.`
                    }
                    if (lastReqId === undefined) {
                        //if transactions started not from the first task.
                        lastReqId = reqId;
                        for (let i = 0; i < lastReqId; i++) {
                                    tasks[i].task.work([]);
                        }
                    } else if (lastReqId !== reqId) {
                        tasks[lastReqId].task.work(currentResult.map(r => r[0]));
                        currentResult = [];
                        // Some users may be skipped if dates didn't include any transactions
                        // listIdx < params.length && params[listIdx].userId != user; listIdx++)
                        for (let i = lastReqId + 1; i < reqId; i++ ) {
                            tasks[i].task.work([]);
                        }
                        lastReqId = reqId;
                    }
                    currentResult.push([line, reqId]);
                })
            } catch(e) {
                metrics?.databaseRequestErrors.inc();
                if (lastReqId !== undefined) {
                    for (let i = lastReqId; i < tasks.length; i++) {
                        tasks[i].task.cancel(`Error processing user ${tasks[i].user} : ${e}`);
                    }
                    // TODO: make a more explicit error state
                    lastReqId = tasks.length;
                }
            }
            if (lastReqId == undefined) {
                lastReqId = 0;
            }
            for (; lastReqId < tasks.length; lastReqId++) {
                tasks[lastReqId].task.work(currentResult.map(r => r[0]));

                currentResult = [];
            }
            await Promise.all(tasks.map(t => t.task.result.catch(_ => {}).finally(() => {
                this.inFlightResuests--;
            })));
            this.bundleTimer.refresh();
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
                return new Serialiser();
            }
        });
    }
}