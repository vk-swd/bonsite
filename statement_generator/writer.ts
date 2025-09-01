

import * as fsp from 'fs/promises';


class Writer {
    messages: string[] = [];
    handle: fsp.FileHandle | undefined;
    writing = false;
    stopping = false;
    closed = false;
    waiter: Promise<void>;
    resolver: () => void = () => { };
    constructor(fileName: string) {
        fsp.open(fileName, 'a').then(h => {
            this.handle = h;
            this.write();
        });
        this.waiter = new Promise<void>(resolve => this.resolver = resolve);
    }
    stop() {
        if (!this.stopping && !this.closed) {
            this.stopping = true;
            this.close()
        }
        return this.waiter;           
    }
    private close() {
        if (this.closed || this.writing) {
            return;
        }
        if (this.messages.length == 0) {
            this.closed = true;
            this.handle?.close().catch(_ => { }).finally(() => this.resolver());
        }                
    }
    addMessage(line: string) {
        if (this.stopping || this.closed) {
            return;
        }
        this.messages.push(line);
        this.write();
    }
    private write() {
        if (this.writing || this.handle === undefined || this.messages.length == 0) {
            return;
        }
        this.writing = true;
        const message = this.messages[0];
        this.messages = this.messages.slice(1);
        this.handle.write(message + "\n").then(_ => {
            this.writing = false;
            if (this.stopping && this.messages.length == 0) {
                this.close();
            } else {
                this.write();
            }
        }).catch(e => {
            throw new Error(`error writing ${message} : ${e}`);
        });
    }
}

export class WriterManager {
    writers: Map<string, Writer> = new Map();
    constructor(public baseDir: string) {
    }
    getWriter(fileName: string): Writer {
        if (!this.writers.has(fileName)) {
            this.writers.set(fileName, new Writer(fileName));
        }
        return this.writers.get(fileName)!;
    }
    stopAll() {
        Promise.all(Array.from(this.writers.values()).map(w => w.stop()));
    }
    writeLine(fileName: string, line: string) {
        this.getWriter(fileName).addMessage(line);
    }
    stopWriter(fileName: string) {
        const w = this.writers.get(fileName);
        if (w) {
            w.stop()!.then(_ => {
                if (this.writers.has(fileName)) {
                    // if (this.writers.get(fileName)!.closed) { --- IGNORE as this writer is not supposed to live long ---}
                    this.writers.delete(fileName);
                }
            });
        }
    }
}