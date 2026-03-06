

import * as fsp from 'fs/promises';
import { Deferred } from '../common/utils.js';


export class Writer {
    messages: string[] = [];
    handle: fsp.FileHandle | undefined;
    writing = false;
    stopping = false;
    closed = false;
    deferred = new Deferred<number>();
    pos = 0;
    writtenLines = 0;
    constructor(private fileName: string) {
        //TODO: make it open file only if there is something to write (on the 1st line)
        fsp.open(fileName, 'a').then(h => {
            this.handle = h;
            this.write();
        }).catch(e => {
            this.deferred.reject(`error opening ${fileName} : ${e}`);
        });
    }
    abort() {
        return this.flushAndStop(true);
    }
    flushAndStop(abort = false): Promise<number> {
        if (!this.stopping && !this.closed) {
            this.stopping = true;
            if (abort) {
                this.messages = [];
            }
            this.close()
        }
        return this.deferred.promise;
    }
    private close(aborted = false) {
        if (this.closed || this.writing) {
            return;
        }
        if (this.messages.length == 0) {
            this.closed = true;
            if (this.handle) {
                this.handle.close().then(_ => {
                    if (aborted) {
                        return fsp.rename(this.fileName, this.fileName + ".aborted");
                        // ???: what if throws here?
                        // ???: does catch wait for this to comlete?
                    }
                }).catch(_ => { }).finally(() => this.deferred.resolve(this.writtenLines));
            } else {
                this.deferred.reject("File handle not opened");
            }
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
        let buffer = "";
        let lineCount = 0;
        while (this.pos < this.messages.length && buffer.length < 256 * 1024) {
            lineCount++;
            buffer += this.messages[this.pos++] + "\n";
        }
        this.messages.splice(0, this.pos);
        this.pos = 0;
        this.handle.write(buffer).then(_ => {
            this.writtenLines += lineCount;
            this.writing = false;
            if (this.stopping && this.messages.length == 0) {
                this.close();
            } else {
                this.write();
            }
        }).catch(e => {
            this.deferred.reject(`error writing to ${this.fileName} : ${e}`);
            this.close();
        });
    }
}
