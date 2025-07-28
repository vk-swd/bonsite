
export type KConsumerOffsetInfo = {
  topic: string, 
  partitions: { id: number, offset?: string }[]
}

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