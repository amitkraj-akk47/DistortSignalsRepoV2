/**
 * Structured logger for Cloudflare Workers
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export interface LogContext {
  [key: string]: any;
}

export class Logger {
  private level: LogLevel;
  private serviceName: string;

  constructor(serviceName: string, level: LogLevel = LogLevel.INFO) {
    this.serviceName = serviceName;
    this.level = level;
  }

  private log(level: LogLevel, message: string, context?: LogContext): void {
    if (level < this.level) return;

    const logEntry = {
      timestamp: new Date().toISOString(),
      level: LogLevel[level],
      service: this.serviceName,
      message,
      ...context,
    };

    console.log(JSON.stringify(logEntry));
  }

  debug(message: string, context?: LogContext): void {
    this.log(LogLevel.DEBUG, message, context);
  }

  info(message: string, context?: LogContext): void {
    this.log(LogLevel.INFO, message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.log(LogLevel.WARN, message, context);
  }

  error(message: string, error?: Error, context?: LogContext): void {
    this.log(LogLevel.ERROR, message, {
      ...context,
      error: error?.message,
      stack: error?.stack,
    });
  }
}

export const logger = new Logger('distortsignals');
