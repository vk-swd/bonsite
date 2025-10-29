


export class Logger {
    private static instance1: Logger;
    backlog = new Array<string>()
    // TODO: make logs delivered to be a dedicated compressed kafka topic
    static get instance(): Logger {
        if (!Logger.instance1) {
            Logger.instance1 = new Logger();
        }
        return this.instance1;
    }
    private constructor() {
        this.log("Logger initialized, backlog size:", this.backlog.length);
    }
    writeLogs(log: string) {
        this.backlog = JSON.parse(localStorage.getItem('logger')??"[]");
        if (this.backlog.length > 20) {
            this.backlog.shift();
        }
        this.backlog.push(log);
        localStorage.setItem('logger', JSON.stringify(this.backlog));
    }
    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance1 = new Logger();
        }
        return Logger.instance;
    }

    // public setLogLevel(level: LogLevel): void {
    //     this.logLevel = level;
    // }

    public error(message: any, ...params: any): void {
        this.writeLogs(JSON.stringify([message, ...params]))
        console.error("%s " + message, new Date().toISOString(), ...params);
    }
    public warn(message: any, ...params: any): void {
        this.writeLogs(JSON.stringify([message, ...params]))
        console.warn("%s " + message, new Date().toISOString(), ...params);
    }
    public info(message: any, ...params: any): void {
        this.writeLogs(JSON.stringify([message, ...params]))
        console.info("%s " + message, new Date().toISOString(), ...params);
    }
    public debug(message: any, ...params: any): void {
        this.writeLogs(JSON.stringify([message, ...params]))
        console.debug("%s " + message, new Date().toISOString(), ...params);
    }
    public log(message: any, ...params: any): void {
        this.writeLogs(JSON.stringify([message, ...params]))
        console.log("%s " + message, new Date().toISOString(), ...params);
    }
}

export const logger = Logger.instance;
// logger.log("", new Date(), `ASSIGNING NEW LOGGER`)
// function saveLogsToLocalStorage() {
//     localStorage.setItem('logger', JSON.stringify(logger.backlog.slice(-1000)));
// }
// window.removeEventListener('beforeunload', saveLogsToLocalStorage);
// window.addEventListener('beforeunload', saveLogsToLocalStorage);
