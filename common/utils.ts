import { clear } from "console";
import { runInThisContext } from "vm";

export function last<T>(a: Array<T>): T | undefined {
    return a[a.length - 1];
}

export function getEnv(name: string): string {
    const value = process.env[name];
    if (value === undefined) {
        throw new Error(`Environment variable ${name} is not set`);
    }
    return value;
}

export class PriorityQ<T> {
    private heap: T[] = [];
    constructor(private isPrioritized: (item:T, overItem:T) => boolean) {}

    push(item: T) {
        this.heap.push(item);
        this.moveUp();
    }

    peek(): T | undefined {
        return this.heap[0];
    }

    pop(): T | undefined {
        const top = this.heap[0];
        const end = this.heap.pop();
        if (this.heap.length && end !== undefined) {
            this.heap[0] = end;
            this.restructure();
        }
        return top;
    }

    private moveUp() {
        let newPos = this.heap.length - 1;
        const item = this.heap[newPos];
        while (newPos > 0) {
            const rootPos = Math.floor((newPos - 1) / 2);
            if (this.isPrioritized(this.heap[rootPos], item)) break;
            this.heap[newPos] = this.heap[rootPos];
            newPos = rootPos;
        }
        this.heap[newPos] = item;
    }

    private restructure() {
        let rootInQuestion = 0;
        const length = this.heap.length;
        while (true) {
            const l = 2 * rootInQuestion + 1
            const r = l + 1;
            let prioritizedIdx = rootInQuestion;
            if (l < length && this.isPrioritized(this.heap[l], this.heap[prioritizedIdx])) {
                prioritizedIdx = l;
            }
            if (r < length && this.isPrioritized(this.heap[r], this.heap[prioritizedIdx])) {
                prioritizedIdx = r;
            }
            if (prioritizedIdx === rootInQuestion) {
                break;
            }
            const ref = this.heap[rootInQuestion]
            this.heap[rootInQuestion] = this.heap[prioritizedIdx];
            this.heap[prioritizedIdx] = ref;
            rootInQuestion = prioritizedIdx;
        }
    }

    isEmpty() {
        return this.heap.length === 0;
    }
    size(): number {
        return this.heap.length;
    }
}


export function testQ() {
    console.log(`${new Date().toLocaleString()} starting test`)
    for (let i = 0; i < 100000; i++) {
        let arr = Array.from({ length: 1000 }, () => Math.floor(Math.random() * 10000));
        const q = new PriorityQ<number>((a,b) => a < b);
        arr.forEach(e => q.push(e));
        arr.sort((a,b) => a - b);
        const resArr = Array.from({ length: arr.length}, () => q.pop());

        let lastVal = -1;
        for (let i1 = 0; i1 < resArr.length; i1++) {
            const v = resArr[i1];
            if (v == undefined || v < lastVal) {
                console.log(`TEST FAILURE. ${v} < ${lastVal} at ${i1} of ${i} sample of size ${arr.length}`);
                throw new Error(`Test failed at ${i}`);
            }
            lastVal = v;
        }
    }
    console.log(`${new Date().toLocaleString()} ending test`)
}



type Range = { start: number; end: number };

export class RangeSet {
    private ranges: Range[] = [];

    add(num: number) {
        if (this.ranges.length === 0) {
            this.ranges.push({ start: num, end: num });
            return;
        }
        if (last(this.ranges)!.end + 1 == num) {
            // Extend the last range
            this.ranges[this.ranges.length - 1].end = num;
            return;
        }
        // Binary search to find where to insert
        let left = 0, right = this.ranges.length - 1;
        while (left <= right) {
            const mid = (left + right) >> 1;
            if (this.ranges[mid].end < num) {
                left = mid + 1;
            } else if (this.ranges[mid].start > num) {
                right = mid - 1;
            } else {
                // Number is inside an existing range → ignore
                return;
            }
        }
        // Try to merge with neighbors
        if (left == this.ranges.length) {
            if (last(this.ranges)!.end + 1 === num) {
                // Extend the last range
                this.ranges[this.ranges.length - 1].end = num;
                return;
            }
            this.ranges.push({ start: num, end: num });
            return;
        }
        if (left === 0) {
            if (this.ranges[0].start - 1 === num) {
                // Extend the first range
                this.ranges[0].start = num;
                return;
            }
            this.ranges.unshift({ start: num, end: num });
            return;
        }

        const prev = this.ranges[right];
        const next = this.ranges[left];
        if (prev.end + 1 !== num && next.start - 1 !== num) {
            this.ranges.splice(left, 0, { start: num, end: num });
            return;
        }
        if (prev.end + 1 === num) {
            // Extend previous range
            prev.end = num;
        }
        if (next.start - 1 === num) {
            next.start = num;
        }
        if (prev.end + 1 >= next.start) {
            // Merge two ranges
            prev.end = next.end;
            this.ranges.splice(left, 1);
        }
    }

    getRanges(): Range[] {
        return this.ranges;
    }
}
function shuffle<T>(array: T[]): void {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1)); // random index from 0 to i
      [array[i], array[j]] = [array[j], array[i]];   // swap elements
    }
  }
export function testRangeSet() {
    console.log(`${new Date().toLocaleString()} starting test`)
    for (let i = 0; i < 100000; i++) {
        const a: string[] = [];
        let arr = Array.from({ length: 1000 }, (_,i) => i);
        shuffle(arr);
        const rs = new RangeSet();
        arr.forEach(e => rs.add(e));
        const ranges = rs.getRanges();
        if (ranges.length !== 1 || ranges[0].start !== 0 || ranges[0].end !== arr.length - 1) {
            console.log(`TEST FAILURE. Expected 1 range, got ${ranges.length} at ${i} sample of size ${arr.length}`);
            throw new Error(`Test failed at ${i}`);
        }
    }
    console.log(`${new Date().toLocaleString()} ending test`)
}

export class Deferred<T> {
    public promise: Promise<T>;
    public resolve!: (value: T | PromiseLike<T>) => void;
    public reject!: (reason?: any) => void;
    constructor() {
        this.promise = new Promise<T>((res, rej) => {
            this.resolve = res;
            this.reject = rej;
        });
    }
}
export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export class UserIdPattern {
    constructor(private userCount: number, private maxSideSize: number = 4) {
        this.remained = this.maxSideSize / 2;
    }
    xpos = 0
    ypos = 0
    horizontal = true;
    remained: number;
    get from(): number {
        return this.xpos;
    }
    get to(): number {
        return this.ypos;
    }
    next() {
        if (this.horizontal) {
            this.xpos = (this.xpos+1) % this.userCount;
        } else {
            this.ypos = (this.ypos+1) % this.userCount;
        }
        this.remained--;
        if (this.remained == 0) {
            this.horizontal = !this.horizontal;
            this.remained = this.maxSideSize;
        }
    }
}

export class ProgressPrinter {
    it = 0;
    progressThreshold: number;
    threshold: number;
    timeout: NodeJS.Timeout | undefined = undefined;
    constructor(private total: number, private msg: (pc: string) => string, private newline = false) {
        this.progressThreshold = total / 50;
        this.threshold = this.progressThreshold;
    }
    update = false;
    writeMsg() {
        if (!this.newline) {
            process.stdout.clearLine(0);   // clear current line
            process.stdout.cursorTo(0);    // move cursor to beginning of line
        }
        process.stdout.write(this.msg((this.it * 100 / this.total).toFixed(0).padStart(3)) + ` of ${this.total}`);
        if (this.newline) {
            process.stdout.write('\n'); // needed to flush the line
        }
        this.update = false;
        if (this.it == this.total) {
            return;
        }
        this.timeout = setTimeout(() => {
            clearTimeout(this.timeout);
            this.timeout = undefined;
            if (this.update) {
                this.writeMsg();
            }
        }, 2000);
    }
    writeProgress(increment?: number) {
        this.it += increment ?? 1;
        if (this.it == this.total) {
            this.writeMsg();
            return;
        }
        if (this.it > this.threshold) {
            this.threshold += this.progressThreshold;
            if (this.timeout) {
                this.update = true;
                return;
            }
            this.writeMsg();
        }
    }
}

export class OverflowingCounter {
    private count = 0;
    static MAX = (0x7FFFFFFFFFFFFFFF - 1) / 2;
    static diff(from: number, to: number): number {
        const oFrom = OverflowingCounter.eval(from);
        const oTo = OverflowingCounter.eval(to);
        if (oTo >= oFrom) {
            return oTo - oFrom;
        }
        return OverflowingCounter.MAX - oFrom + oTo;
    }
    constructor() {}
    set(value: number) {
        this.count = OverflowingCounter.eval(value);
    }
    inc(value = 1) {
        this.count = OverflowingCounter.eval(this.count + value);
        return this.count;
    }
    evalInc(val: number): number {
        return OverflowingCounter.eval(this.count + val);
    }
    static eval(val: number): number {
        if (!Number.isInteger(val)) {
            throw new Error("Value must be an integer")
        }
        return val % OverflowingCounter.MAX;
    }
    get(): number {
        return this.count;
    }
    get value(): number {
        return this.count;
    }
}