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

    const isPretty =
      process.env.LOG_FORMAT === 'pretty' ||
      (!process.env.LOG_FORMAT && process.env.NODE_ENV !== 'production' && !this.isTest);

    let output: string;
    if (isPretty) {
      const time = new Date().toLocaleTimeString([], { hour12: false });
      const colors: Record<LogLevel, string> = {
        DEBUG: '\x1b[90m',
        INFO: '\x1b[36m',
        WARN: '\x1b[33m',
        ERROR: '\x1b[31m'
      };
      const reset = '\x1b[0m';
      const dim = '\x1b[90m';
      const magenta = '\x1b[35m';
      const levelTag = `${colors[level] || ''}[${level.padEnd(5)}]${reset}`;
      const compTag = context.component ? `${magenta}[${context.component}]${reset} ` : '';

      const detailKeys = Object.keys(context).filter((k) => k !== 'component' && k !== 'instanceId');
      const detailsStr = detailKeys.length > 0
        ? ` ${dim}(${detailKeys.map((k) => `${k}: ${typeof context[k] === 'string' ? context[k] : JSON.stringify(context[k])}`).join(', ')})${reset}`
        : '';

      output = `${dim}${time}${reset} ${levelTag} ${compTag}${message}${detailsStr}`;
    } else {
      output = JSON.stringify(logEntry);
    }

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
