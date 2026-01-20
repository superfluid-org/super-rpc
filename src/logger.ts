export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
    NONE = 4
}

export class Logger {
    private level: LogLevel;

    constructor(levelStr: string = "info") {
        switch (levelStr.toLowerCase()) {
            case "debug": this.level = LogLevel.DEBUG; break;
            case "info": this.level = LogLevel.INFO; break;
            case "warn": this.level = LogLevel.WARN; break;
            case "error": this.level = LogLevel.ERROR; break;
            case "none": this.level = LogLevel.NONE; break;
            default: this.level = LogLevel.INFO;
        }
    }

    private formatMsg(level: string, msg: string): string {
        return `[${new Date().toISOString()}] [${level}] ${msg}`;
    }

    public debug(msg: string) {
        if (this.level <= LogLevel.DEBUG) {
            console.debug(this.formatMsg("DEBUG", msg));
        }
    }

    public info(msg: string) {
        if (this.level <= LogLevel.INFO) {
            console.log(this.formatMsg("INFO", msg));
        }
    }

    public warn(msg: string) {
        if (this.level <= LogLevel.WARN) {
            console.warn(this.formatMsg("WARN", msg));
        }
    }

    public error(msg: string) {
        if (this.level <= LogLevel.ERROR) {
            console.error(this.formatMsg("ERROR", msg));
        }
    }
}
