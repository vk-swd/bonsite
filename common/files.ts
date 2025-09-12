import { createInterface } from "readline";
import fs from "fs";
import { once } from "events";
import { logger } from "./logger.js";
import { Deferred } from "./utils.js";
import { fail } from "assert";



export async function processLineByLine(fileName: string, processor: (line: string) => Promise<void>, maxInFlight?: number): Promise<number> {
    const deferred = new Deferred<number>();
    const rl = createInterface({
        input: fs.createReadStream(fileName),
        crlfDelay: Infinity,
    });
    let inFlight = 0;
    let done = false;
    let failed = false;
    let paused = false;
    let lineCount = 0;
    const errorLengthLimit = 100;
    const lineQueue: string[] = [];
    let timer: NodeJS.Timeout | undefined = undefined;
    const setTimer = () => {
        if (timer) {
            return
        }
        timer = setTimeout(() => {
            logger.warn(`Processing paused for too long ${lineQueue.length} lines in queue, ${inFlight} in flight`);
            clearTimeout(timer);
            timer = undefined;
            if ((done && lineQueue.length == 0) || failed) {
                return;
            }
            setTimer(); 
        }, 10000);
    }
    const processedQueued = () => {
        if ((done && lineQueue.length == 0) || failed) {
            return;
        }
        const toProcess = maxInFlight ? Math.min(maxInFlight - inFlight, lineQueue.length) : lineQueue.length;
        inFlight += toProcess;
        if (maxInFlight) {
            if (inFlight >= maxInFlight && !paused) {
                paused = true;
                if (!done) {
                    rl.pause();
                }
                setTimer();
            } else if (inFlight < maxInFlight && paused) {
                paused = false;
                clearTimeout(timer);
                timer = undefined;
                if (!done) {
                    rl.resume();
                }
            }
        }
        Promise.all(lineQueue.splice(0,toProcess).map(line => {
            processor(line)
            .then(() => {
                inFlight--;
                lineCount++;
                if (inFlight === 0 && lineQueue.length === 0 && done) {
                    deferred.resolve(lineCount);
                    return;
                }
                processedQueued();
            })
            .catch((e) => {
                deferred.reject(e);
                failed = true;
                if (!done) {
                    rl.close();
                }
            })
        }))
    }
    rl.on('line', async (line) => {
        lineQueue.push(line);
        if (paused) {
            return;
        }
        processedQueued();
    });
    await once(rl, 'close');
    done = true;
    if (inFlight == 0 && lineQueue.length === 0) {
        deferred.resolve(lineCount);
    }
    return deferred.promise;
}
