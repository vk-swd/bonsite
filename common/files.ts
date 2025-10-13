import { createInterface, Interface } from "readline";
import fs from "fs";
import { once } from "events";
import { logger } from "./logger.js";
import { Deferred } from "./utils.js";


type ReadLinesState = {
    rl: Interface
    timer: NodeJS.Timeout | undefined, done: boolean,
    hardStop: boolean, inFlight: number, lineQueue: string[],
    lineCount: number, paused: boolean,
    maxInFlight: number,
    deferred: Deferred<number>,
    lines?: number
};

const setTimer = (state: ReadLinesState) => {
    // Report line processing state at intervals
    if (state.timer) {
        return
    }
    state.timer = setTimeout(() => {
        logger.warn(`Processing, ${state.lineQueue.length} lines in queue, ${state.inFlight} in flight`);
        clearTimeout(state.timer);
        state.timer = undefined;
        if ((state.done && state.lineQueue.length == 0) || state.hardStop) {
            return;
        }
        setTimer(state);
    }, 10000);
}
const processedQueued = (state: ReadLinesState, processor: (line: string) => Promise<void>) => {
    if ((state.done && state.lineQueue.length == 0) || state.hardStop) {
        return;
    }
    const toProcess = state.maxInFlight ? Math.min(state.maxInFlight - state.inFlight, state.lineQueue.length) : state.lineQueue.length;
    state.inFlight += toProcess;
    if (state.maxInFlight) {
        if (state.inFlight >= state.maxInFlight && !state.paused) {
            state.paused = true;
            if (!state.done) {
                state.rl.pause();
            }
            setTimer(state);
        } else if (state.inFlight < state.maxInFlight && state.paused) {
            state.paused = false;
            clearTimeout(state.timer);
            state.timer = undefined;
            if (!state.done) {
                state.rl.resume();
            }
        }
    }
    Promise.all(state.lineQueue.splice(0,toProcess).map(line => {
        processor(line)
        .then(() => {
            state.inFlight--;
            state.lineCount++;
            if (state.lines && state.lineCount >= state.lines) {
                state.deferred.resolve(state.lineCount);
                state.hardStop = true;
                state.rl.close();
            }
            if (state.inFlight === 0 && state.lineQueue.length === 0 && state.done) {
                state.deferred.resolve(state.lineCount);
                return;
            }
            processedQueued(state, processor);
        })
        .catch((e) => {
            state.deferred.reject(e);
            state.hardStop = true;
            if (!state.done) {
                state.rl.close();
            }
        })
    }))
}
export async function processLineByLine(fileName: string, 
    /* state machine:
        1. no_pause|no_done|no_hardStop|in_flight_low|lineQ=0|no_timer|linesPending
        2. no_pause
    */
    processor: (line: string) => Promise<void>, maxInFlight?: number, lines?: number): Promise<number> {;
    const state: ReadLinesState = { 
        rl: createInterface({
            input: fs.createReadStream(fileName),
            crlfDelay: Infinity,
        }),
        deferred: new Deferred<number>(),
        timer: undefined, 
        done: false, 
        hardStop: false, 
        paused: false, 
        inFlight: 0,
        lineQueue: [], 
        lineCount: 0,
        maxInFlight: maxInFlight??1000000,
        lines: lines
    };
    state.rl.on('line', async (line) => {
        state.lineQueue.push(line);
        if (state.paused) {
            return;
        }
        processedQueued(state, processor);
    });
    await once(state.rl, 'close');
    state.done = true;
    if (state.inFlight == 0 && state.lineQueue.length === 0) {
        state.deferred.resolve(state.lineCount);
    }
    return state.deferred.promise;
}
