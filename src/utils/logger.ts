import winston from 'winston';
import { ProxyConfig } from '@/types/config';

/**
 * Logger Service - Singleton pattern for application logging
 */
export class Logger {
  private static instance: Logger;
  private logger: winston.Logger;

  private constructor(config: ProxyConfig) {
    this.logger = this.createLogger(config);
  }

  static getInstance(config?: ProxyConfig): Logger {
    if (!Logger.instance && config) {
      Logger.instance = new Logger(config);
    }
    return Logger.instance;
  }

  private createLogger(config: ProxyConfig): winston.Logger {
    const transports: winston.transport[] = [];

    // Production file transports
    if (config.server.environment === 'production') {
      transports.push(
        new winston.transports.File({
          filename: 'logs/error.log',
          level: 'error',
          maxsize: 10485760, // 10MB
          maxFiles: 5,
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.errors({ stack: true }),
            winston.format.json()
          ),
        }),
        new winston.transports.File({
          filename: 'logs/combined.log',
          maxsize: 10485760,
          maxFiles: 5,
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.errors({ stack: true }),
            winston.format.json()
          ),
        })
      );
    }

    // Console transport for development or when explicitly enabled
    if (config.logging.enableConsole) {
      transports.push(
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            winston.format.colorize(),
            winston.format.printf(({ timestamp, level, message, ...meta }) => {
              const metaStr = Object.keys(meta).length > 0 ? JSON.stringify(meta) : '';
              return `[${timestamp}] ${level}: ${message} ${metaStr}`;
            })
          ),
        })
      );
    }

    return winston.createLogger({
      level: config.logging.level,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      transports,
      exitOnError: false,
    });
  }

  getLevel(): string {
    return this.logger.level;
  }

  setLevel(level: string): void {
    this.logger.level = level;
  }

  info(message: string, meta?: object): void {
    this.logger.info(message, meta);
  }

  error(message: string, error?: Error | object): void {
    if (error instanceof Error) {
      this.logger.error(message, {
        error: error.message,
        stack: error.stack,
        name: error.name,
      });
    } else {
      this.logger.error(message, error);
    }
  }

  warn(message: string, meta?: object): void {
    this.logger.warn(message, meta);
  }

  debug(message: string, meta?: object): void {
    this.logger.debug(message, meta);
  }

  http(message: string, meta?: object): void {
    (this.logger as any).http ? (this.logger as any).http(message, meta) : this.logger.info(message, meta);
  }

  // Performance logging helper
  timeStart(label: string): void {
    console.time(label);
  }

  timeEnd(label: string): void {
    console.timeEnd(label);
  }

  // Create child logger with additional context
  child(defaultMeta: object): winston.Logger {
    return this.logger.child(defaultMeta);
  }
}
