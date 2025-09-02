



export class Logger {
    private static instance: Logger;
    // private logLevel: LogLevel;

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

    public error(message: string): void {
        console.error(new Date().toISOString(), message);
    }
    public warn(message: string): void {
        console.warn(new Date().toISOString(), message);
    }
    public info(message: string): void {
        console.info(new Date().toISOString(), message);
    }
    public debug(message: string): void {
        console.debug(new Date().toISOString(), message);
    }
    public log(message: string/*, level: LogLevel = LogLevel.INFO*/): void {
        console.log(new Date().toISOString(), message);
        // if (level >= this.logLevel) {
        //     console.log(`[${LogLevel[level]}] ${message}`);
        // }
    }
}


export const logger = Logger.getInstance();