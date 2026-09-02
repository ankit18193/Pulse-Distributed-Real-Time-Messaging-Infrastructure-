/**
 * Pulse Structured JSON Logger
 */

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface LogContext {
  instanceId?: string;
  traceId?: string;
  component?: string;
  event?: string;
  connectionId?: string;
  userId?: string;
  roomId?: string;
  durationMs?: number;
  [key: string]: unknown;
}

export class Logger {
  private instanceId: string;
  private isTest: boolean;

  constructor(instanceId: string = 'pulse-node-1') {
    this.instanceId = instanceId;
    this.isTest = process.env.NODE_ENV === 'test';
  }

  public setInstanceId(id: string): void {
    this.instanceId = id;
  }

  private log(level: LogLevel, message: string, context: LogContext = {}): void {
    if (this.isTest && level === 'DEBUG') {
      return;
    }

    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      service: 'pulse',
      instanceId: context.instanceId || this.instanceId,
      message,
      ...context
    };

    const output = JSON.stringify(logEntry);
    if (level === 'ERROR') {
      console.error(output);
    } else if (level === 'WARN') {
      console.warn(output);
    } else {
      console.log(output);
    }
  }

  public debug(message: string, context?: LogContext): void {
    this.log('DEBUG', message, context);
  }

  public info(message: string, context?: LogContext): void {
    this.log('INFO', message, context);
  }

  public warn(message: string, context?: LogContext): void {
    this.log('WARN', message, context);
  }

  public error(message: string, context?: LogContext): void {
    this.log('ERROR', message, context);
  }
}

export const logger = new Logger();
