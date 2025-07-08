



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
        console.error(new Date().toLocaleString(), message);
    }
    public warn(message: string): void {
        console.warn(new Date().toLocaleString(), message);
    }
    public info(message: string): void {
        console.info(new Date().toLocaleString(), message);
    }
    public debug(message: string): void {
        console.debug(new Date().toLocaleString(), message);
    }
    public log(message: string/*, level: LogLevel = LogLevel.INFO*/): void {
        console.log(new Date().toLocaleString(), message);
        // if (level >= this.logLevel) {
        //     console.log(`[${LogLevel[level]}] ${message}`);
        // }
    }
}


export const logger = Logger.getInstance();