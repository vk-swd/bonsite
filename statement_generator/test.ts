
import { BundleHandler, FileWriter, BaseWorker, Preparer } from './preparer.js';
import { UserConnection } from '../common/db/db_defines.js';
import { createSchema } from '../common/db/init.js';
import { InKafkaMessage, MAX_DATE, Metadata, MetadataValidator, MetadataWrapperValidator, MIN_DATE, StatementParameters, StatementType, Transaction, TransactionResult, TResult, UserDataValidator } from '../common/event_types.js';
import { Deferred, getEnv, last, ProgressPrinter, sleep, UserIdPattern } from '../common/utils.js';
import {it, describe} from 'mocha'
import fsp from 'fs/promises';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { logger } from '../common/logger.js';
import { connectToDatabase, runQuery } from '../common/db/common.js';
import { Counters, UserCounters } from '../common/generator_parameters.js';
import { procGetTransactions, SetUpTempTableProc, setUpTempTransactionResultsTable, setUpTempTransactionsTable } from '../common/db/procedures.js';
import { parseQueryRes, TransactionResultStored, transactionsTable, TransactionStored, usersTable } from '../common/db/tables.js';
import { processLineByLine } from '../common/files.js';

chai.use(chaiAsPromised);
chai.config.includeStack = true;
chai.config.truncateThreshold = 10000

const topics = ["trans", "res"];
const [topic_transaction_res, topic_transactions] = topics;

const SHARED_DIR = getEnv('SHARED_DIR');
const user_sa = getEnv('MSSQL_SA_USERNAME')

let db_connection: UserConnection | undefined = undefined
describe('Sanity check', function () {
    this.timeout(1000000); // Set timeout for the tests
    this.beforeAll(async () => {
        const pool = await connectToDatabase(user_sa)!;
        db_connection = new UserConnection(pool);
    });
    it(`Sanity check`, async () => {
        const val = 100;
        const d = new Deferred<number>();
        d.resolve(5);
        expect(d.promise).to.eventually.equal(5);
        d.reject("some error");
        expect(d.promise).to.eventually.equal(5);
        //fire-and-forget async tasks update shared state safely
        async function f(numb: number) {
            await sleep(300);
            if (numb > 5) {
                throw "promise throws";
            }
            return numb;
        }

        function caller(eb: (num: number) => Promise<number>,  v: number) {
            return eb(v)
        }
        let nums: number[] = [];
        for (let i = 0; i < 10; i++) {
            caller(f, i).then(res => {
                nums.push(res);
            });
        }
        expect(nums).to.be.empty
        await sleep(1000);
        expect(nums.length).to.equal(6);
    });
    const userCount = 100000;
    type MsgOffset = { msg: InKafkaMessage, offset: string };
    const sendBatch = async (tempTableGen: SetUpTempTableProc<TransactionStored | TransactionResultStored>, 
                             messages: MsgOffset[], topic: string, addConflicts: boolean = false) => {
        if (addConflicts) {
            // add something that would trigger "catch" clause in message commit procedure
            // duplicates should do
            messages.push(...messages);
            messages.sort((l,r) => l.msg.payload.dateTime - r.msg.payload.dateTime);
        }
        return await db_connection!.writeDataTransactionally(
            tempTableGen,
            messages.map(v => v.msg),
            {
                groupId: '0',
                offset: last(messages)!.offset,
                partition: 0,
                topic
            })
    }

    it(`Test normal case`, async () => {
        await createSchema(db_connection!.pool, "TestDBStatementGen");
        const batchSize = 10000;
        const transactions: MsgOffset[] = [];
        const cycles = 800000;
        const time = Date.now();
        const userIdPattern = new UserIdPattern(userCount);
        const timeIncrement = 100;
        for (let i = 1; i <= cycles; i++) {
            const dateTime = i * timeIncrement;
            const id = i;
            const userIdFrom = userIdPattern.from;
            const userIdTo = userIdPattern.to;
            const state = i % 100 < 95 ? TResult.CONFIRMED : TResult.BLOCKED
            const amount = i % 100;
            const metadata: Metadata = {
                state,
                userDatePtrs: [{ userId: userIdFrom }, { userId: userIdTo }],
                dateTime
            }
            transactions.push({ msg: { payload: { id, dateTime, amount, userIdFrom, userIdTo }, metadata }, offset: i.toString() });
            userIdPattern.next();
        }
        const lastTransactionMap = new Map<number, InKafkaMessage>();
        const markMetadata = (metadata: Metadata, userId: number, date: number) => {
            const lastRecord = lastTransactionMap.get(userId);
            if (lastRecord !== undefined) {
                const priorMeta = lastRecord.metadata.userDatePtrs!.find(d => d.userId == userId)!
                priorMeta.dateAfter = date;
                metadata.userDatePtrs!.find(d => d.userId == userId)!.dateBefore = lastRecord.payload.dateTime;
            }
        }
        for (const t of transactions) {
            const transaction = t.msg.payload as Transaction;
            if (t.msg.metadata.state !== TResult.CONFIRMED) {
                continue;
            }
            markMetadata(t.msg.metadata, transaction.userIdFrom, transaction.dateTime);
            lastTransactionMap.set(transaction.userIdFrom, t.msg);
            if (transaction.userIdTo != transaction.userIdFrom) {
                markMetadata(t.msg.metadata, transaction.userIdTo, transaction.dateTime);
                lastTransactionMap.set(transaction.userIdTo, t.msg);
            }
        }

        let i = 0;
        while (i < transactions.length) {
            const batch = transactions.slice(i, i + batchSize);
            i += batchSize
            const transactionResults: MsgOffset[] = batch.map(t => {
                const tr: TransactionResult = {
                    id: t.msg.payload.id,
                    dateTime: t.msg.payload.dateTime,
                    state: t.msg.metadata.state!
                }
                return { msg: { payload: tr, metadata: { } }, offset: t.offset };
            });
            // for the last batch, commit everything, otherwise leave the last one in the buffer to maintain dateBefore/After integrity
            const resT = await sendBatch(setUpTempTransactionsTable, batch, topic_transactions);
            const resR = await sendBatch(setUpTempTransactionResultsTable, transactionResults, topic_transaction_res);
            expect(resT.duds, `unexpected duds for transactions at batch ending with ${i}`).to.equal(0);
            expect(resR.duds, `unexpected duds for transaction results at batch ending with ${i}` ).to.equal(0);
            expect(resT.newCount, `unexpected newCount for transactions at batch ending with ${i}`).to.equal(batch.length);
            expect(resR.newCount, `unexpected newCount for transaction results at batch ending with ${i}`).to.equal(transactionResults.length);
            expect(resT.rolledBack, `unexpected rolledBack for transactions at batch ending with ${i}`).to.be.false;
            expect(resR.rolledBack, `unexpected rolledBack for transaction results at batch ending with ${i}`).to.be.false;
            process.stdout.clearLine(0);   // clear current line
            process.stdout.cursorTo(0);    // move cursor to beginning of line
            process.stdout.write(`Progress: ${i * 100 / cycles}%`);
        }
        const newTime = Date.now();
        process.stdout.write(`\n`);
        logger.log(`written in ${newTime - time} ms`);
    })

    const analyzeUser = (transactions: InKafkaMessage[], params: StatementParameters) => {
        const print = (i?: number) => {
            return `User ${params.userId} ` + (i !== undefined ? `transaction  ${JSON.stringify(transactions![i])},` : ``) + ` params ${JSON.stringify(params)}`;
        }
        for (let i = 0; i < transactions!.length; i++) {
            // completeness check - that records are within date bounds and thath
            // no records were missed within those bounds (checked via metadata.dateBefore/After)
            const line = transactions![i]
            const userMeta = line.metadata.userDatePtrs!.find(d => d.userId == params.userId)!;
            expect(line.payload.dateTime, `${print(i)} earlier then expected`).to.be.greaterThanOrEqual(params.fromm!);
            expect(line.payload.dateTime, `${print(i)} later then requested`).to.be.lessThanOrEqual(params.too!);
            if (i == 0 && userMeta.dateBefore !== undefined) {
                expect(userMeta.dateBefore, `${print(i)} first item not first`).to.be.lessThan(params.fromm!);
            }
            if (i == transactions!.length - 1 && userMeta.dateAfter !== undefined) {
                expect(userMeta.dateAfter, `${print(i)} last item not last`).to.be.greaterThan(params.too!);
            }
            if (i > 0) {
                const prevTransMeta = transactions![i-1].metadata.userDatePtrs!.find(d => d.userId == params.userId)!;
                expect(prevTransMeta.dateAfter, `${print(i)} no next date`).to.not.be.undefined;
                expect(userMeta.dateBefore, `${print(i)} no previous date`).to.not.be.undefined;
                expect(line.payload.dateTime, `${print(i)} out of order`).to.be.eq(prevTransMeta.dateAfter!);
                expect(userMeta.dateBefore, `${print(i)} out of order`).to.be.eq(transactions![i-1].payload.dateTime);
            }
            expect(line.payload.id, `${print(i)} Wrong User id`).to.be.greaterThan(params.userId);
        }
    }

    const testParameters = async (p: StatementParameters[]) => {
        // Transactions must be sorted by userId so when the data for new user comes, the previous user is considered done
        let analyzedTransactions = 0;
        const errors: string[] = [];
        const progressTracker = new ProgressPrinter(p.length, (pc) => `Processing statements: ${pc}%`);
        class WorkerLocal extends BaseWorker<number> {
            constructor(private params: StatementParameters) {
                super();
            }
            buffer: InKafkaMessage[] = [];
            handle(_: InKafkaMessage): void {
                this.buffer.push(_);
            }
            finish(): Promise<void> {
                try {
                    analyzeUser(this.buffer, this.params);
                    this.deferred.resolve(this.buffer.length);
                } catch(e) {
                    errors.push(`\nError processing user ${this.params.userId} : ${e}`);
                    this.deferred.reject(e);
                }
                return Promise.resolve();
            }
        }
        const preparer1 = new BundleHandler<number>(100000, db_connection!, (p: StatementParameters) => {
            return new WorkerLocal(p);
        });
        await Promise.all(p.map(par => preparer1.addTask(par).then(r => {
            progressTracker.writeProgress();
            analyzedTransactions += r;
        })));
        expect(errors, `Got errors:\n${errors.join('\n')}`).to.be.empty;
        return analyzedTransactions;
    }
    const testParametersWrites = async (p: StatementParameters[]) => {
        // Produce "n.length" satement files, then read them all, analyze and delete
        let analyzedTransactions = 0;
        const preparer1 = new BundleHandler(1000, db_connection!, (p: StatementParameters) => {
            const fileName = `statement-${p.userId}-${new Date().toISOString()}.json`;
            return new FileWriter(fileName, p);
        });
        const progressWrite = new ProgressPrinter(p.length, (pc) => `files written ${pc}%, files read 0%`);
        const files = (await Promise.all(p.map(par => preparer1.addTask(par).then(r=> {
            progressWrite.writeProgress();
            return r;
        })))).map(r => r.filePath);

        async function getMessages(fileName: string) {
            const messages: InKafkaMessage[] = [];
            await processLineByLine(fileName, async (line: string) => {
                messages.push(MetadataWrapperValidator.parse(JSON.parse(line)));
            });
            return messages;
        }
        const progressRead = new ProgressPrinter(p.length, (pc) => `files written 100%, files read ${pc}%`);
        for (let i = 0; i < files.length; i++) {
            const fileName = SHARED_DIR + "/" + files[i];
            const messages = await getMessages(fileName);
            analyzedTransactions += messages.length;
            analyzeUser(messages, p[i]);
            fsp.unlink(fileName).then(() => {
                progressRead.writeProgress();
            });
        }
        return analyzedTransactions;
    }
    const generateParameters = (userCounter: [number, Counters][]): StatementParameters[] => {
        const threshold = Math.random();
        return userCounter.filter(() => Math.random() < threshold).map(c => {
            const minDate = c[1].minDate??new Date(MIN_DATE).getTime();
            const maxDate = c[1].maxDate??new Date(MAX_DATE).getTime();
            const dateRange = maxDate - minDate;
            const itemCount = c[1].transactionCount;
            if (itemCount == 0) {
                return { userId: c[0], fromm: new Date(MIN_DATE).getTime(),
                    too: new Date(MAX_DATE).getTime(), type: StatementType.FS};
            }
            const minDateToGen = Math.floor(minDate - dateRange / itemCount);
            const maxDateToGen = Math.ceil(maxDate + dateRange / itemCount);
            // Add some room for the first and last item to make them more likely to be included
            const dateRangeToGen = maxDateToGen - minDateToGen;

            const fromm: number | undefined = Math.min(maxDate, minDateToGen + Math.floor(Math.random() * dateRangeToGen));
            const too: number | undefined = Math.max(minDate, fromm + Math.floor(Math.random() * (maxDateToGen - fromm)));
            return { userId: c[0], fromm, too, type: StatementType.FS };
        });
    }
    const readStats = async () => {
        const userCounterMap = new UserCounters();
        let streamedLines = 0;
        let progressRead: ProgressPrinter | undefined = undefined;
        await db_connection?.streamTable(transactionsTable.name, (row, count) => {
            const res = parseQueryRes(row, transactionsTable.columns);
            const meta = MetadataValidator.parse(JSON.parse(res.metadata));
            expect(meta.dateTime, `Loosing precision during ISO date conversion`).to.be.eq(res.dateTime);
            expect(meta.state, `metadata.state for transaction id=${res.id} is undefined`).to.not.be.undefined
            if (meta.state == TResult.CONFIRMED) {
                const counterFrom = userCounterMap.get(res.userIdFrom);
                counterFrom.transactionCount++;
                counterFrom.updateMinDate(res.dateTime);
                counterFrom.updateMaxDate(res.dateTime);
                if (res.userIdFrom != res.userIdTo) {
                    const counterTo = userCounterMap.get(res.userIdTo);
                    counterTo.transactionCount++;
                    counterTo.updateMinDate(res.dateTime);
                    counterTo.updateMaxDate(res.dateTime);
                }
            }
            streamedLines++;
            if (progressRead == undefined) {
                progressRead = new ProgressPrinter(count, (pc) => `Streaming files to read stats: ${pc}%`)
            }
            progressRead.writeProgress();
        });
        const userCounter = Array.from(userCounterMap.data.entries()).map(e => [e[0], e[1]] as [number, Counters]);
        userCounter.sort((l, r) => l[0] - r[0]);
        return userCounter;
    }
    it(`Try read statements`, async () => {
        // Test checks that output records are within requested date range
        // It also checkes and that no records are missed IF at least one record was returned

        // await createSchema(db_connection!.pool, "TestDBStatementGen");
        await db_connection?.pool.query(`use TestDBStatementGen`);
        await db_connection!.pool.query(`drop procedure if exists ${procGetTransactions.procName}`)
        await runQuery(db_connection!.pool, procGetTransactions.getProcedureQuery());

        const userCounter:[number, Counters][] = await readStats();
        const interations = 20
        let t1 = Date.now();
        type SpeedStat = [number, number, number, number, number]; // transactions, users, ms total, ms read
        const speedStats: SpeedStat[] = [];
        const printStat = (s: SpeedStat) => {
            return `${s[0]} t-s, ${s[1]} users, ${s[3]} ms, ${s[4]}ms, ${(s[0]/s[1]).toFixed(0)} t/user ${(s[0]/s[3]).toFixed(0)} t/ms`
        }
        const progressTracker = new ProgressPrinter(interations, (pc) => `Processing stats: ${printStat(last(speedStats)!)}. Progress: ${pc}%`);
        for (let i = 0; i < interations; i++) {
            const parameters = generateParameters(userCounter);
            const newNow1 = Date.now();
            const elapsed1 = newNow1 - t1;
            let elapsed11 = 0;
            t1 = newNow1;
            if (parameters.length == 0) {
                continue;
            }
            let transactions
            let rawLines;
            try {
                process.stdout.write(`\n`); // for progress output
                transactions = await testParametersWrites(parameters);
                elapsed11 = Date.now() - t1;
                rawLines = await testParameters(parameters);
            } catch(e) {
                throw `Error ${JSON.stringify(e).slice(-5000)} at iteration ${i} of ${parameters.length}`;
            }
            expect(transactions, `Different number of transactions processed in write and read modes`).to.be.eq(rawLines);
            const newNow = Date.now();
            const elapsed = newNow - t1;
            t1 = newNow;
            speedStats.push([transactions!, parameters.length, elapsed1, elapsed, elapsed11]);
            progressTracker.writeProgress();
        }
        console.log(`\nDone ${speedStats.map(s => printStat(s)).join('\n')}`)
    })
    it(`User request`, async () => {
        await createSchema(db_connection!.pool, "TestDBStatementGenUserReq");
        await db_connection?.pool.query(`use TestDBStatementGenUserReq`);
        const usersToInsert = [
            { id: 1, name: 'User1' },
            { id: 10, name: 'User10' },
            { id: 100, name: 'User100' },
            { id: 1000, name: 'User1000' },
            { id: 10000, name: 'User10000' },
            { id: 100000, name: 'User100000' },
            { id: 1000000, name: 'User1005' },
            { id: 10000000, name: 'User10006' },
            { id: 100000000, name: 'User100007' },
            { id: 1000000000, name: 'User1000008' },
            { id: 2000000000, name: 'User200000' },
            { id: 3000000000, name: 'User300000' },
            { id: 4000000000, name: 'User400000' },
            { id: 5000000000, name: 'User500000' }
        ]
        await runQuery(db_connection!.pool, `insert into ${usersTable.name} values
            ${usersToInsert.map(u => `(${u.id}, '${u.name}')`).join(',')}
        `);
        // const res1 = await runQuery(db_connection!.pool, `select * from ${usersTable.name}
        //     where ${usersTable.columns.name.name} like '%'`);
        // console.log(`Users in DB: ${JSON.stringify(res1)}`);
        const res = await db_connection!.getUsers({ pattern: '%', count: 4 })
        console.log(`Got users ${JSON.stringify(res)}`);
    })
    it.only(`DB state + paginated statement request`, async () => {
        await createSchema(db_connection!.pool, "TestDBStatementGenDBstatePagedStatements");
        const transactions: MsgOffset[] = Array.from({length: 100}).map((_, idx) => {
            return { msg: {
                    payload: { id: idx, userIdFrom: 1, userIdTo: 2, amount: idx, dateTime: idx * 1000 },
                    metadata: {} }, offset: idx.toString()}; });
        const transactionRes: MsgOffset[] = transactions.map(t => {
            return { msg: { payload:
                {id: t.msg.payload.id, dateTime: t.msg.payload.dateTime, state: TResult.CONFIRMED },
                metadata: {}}, offset: t.offset };
        });
        await sendBatch(setUpTempTransactionsTable, transactions, topic_transactions);
        await sendBatch(setUpTempTransactionResultsTable, transactionRes, topic_transaction_res);
        const state = await db_connection!.getDBState();
        const praparer = new Preparer(db_connection!);
        const g1 = await praparer.addTask({ userId: 1, fromm: 10 * 1000, too: 20 * 1000, count: 1, type: StatementType.DS });
        const g2 = await praparer.addTask({ userId: 1, fromm: 10 * 1000, too: 20 * 1000, offset: 1, count: 1, type: StatementType.DS });
        expect(g1.transactions.length).to.equal(1);
        expect(g1.transactions[0]).to.deep.equal(transactions[10].msg.payload);
        expect(g2.transactions.length).to.equal(1);
        expect(g2.transactions[0]).to.deep.equal(transactions[11].msg.payload);
        expect(state.userCount).to.equal(2);
        expect(state.transactionCount).to.equal(100);
        expect(JSON.parse(state.lastTransactionPosted!)).to.be.deep.eq((last(transactions)?.msg.payload));
        expect(JSON.parse(state.lastTransactionRes!)).to.be.deep.eq((last(transactionRes)?.msg.payload));
    })
});
