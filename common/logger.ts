



export class Logger {
    private static instance: Logger;
    // TODO: make logs delivered to be a dedicated compressed kafka topic

    private constructor() {
        // this.logLevel = LogLevel.INFO; // Default log level
    }

    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    // public setLogLevel(level: LogLevel): void {
    //     this.logLevel = level;
    // }

    public error(message: any, ...params: any): void {
        console.error("%s " + message, new Date().toISOString(), ...params);
    }
    public warn(message: any, ...params: any): void {
        console.warn("%s " + message, new Date().toISOString(), ...params);
    }
    public info(message: any, ...params: any): void {
        console.info("%s " + message, new Date().toISOString(), ...params);
    }
    public debug(message: any, ...params: any): void {
        console.debug("%s " + message, new Date().toISOString(), ...params);
    }
    public log(message: any, ...params: any): void {
        console.log("%s " + message, new Date().toISOString(), ...params);
    }
}


export const logger = Logger.getInstance();