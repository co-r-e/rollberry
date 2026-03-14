import { appendFile } from 'node:fs/promises';

export type CaptureLogLevel = 'info' | 'warn' | 'error';

export interface CaptureLogEvent {
  timestamp: string;
  level: CaptureLogLevel;
  event: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface CaptureLogger {
  info(
    event: string,
    message: string,
    data?: Record<string, unknown>,
  ): Promise<void>;
  warn(
    event: string,
    message: string,
    data?: Record<string, unknown>,
  ): Promise<void>;
  error(
    event: string,
    message: string,
    data?: Record<string, unknown>,
  ): Promise<void>;
  close(): Promise<void>;
}

export function createCaptureLogger(logFilePath: string): CaptureLogger {
  let queue = Promise.resolve();

  const write = async (
    level: CaptureLogLevel,
    event: string,
    message: string,
    data?: Record<string, unknown>,
  ): Promise<void> => {
    const logEvent: CaptureLogEvent = {
      timestamp: new Date().toISOString(),
      level,
      event,
      message,
      data,
    };

    process.stderr.write(
      `${logEvent.timestamp} [${level.toUpperCase()}] ${message}\n`,
    );

    queue = queue.then(() =>
      appendFile(logFilePath, `${JSON.stringify(logEvent)}\n`, 'utf8'),
    );
    await queue;
  };

  return {
    info(event, message, data) {
      return write('info', event, message, data);
    },
    warn(event, message, data) {
      return write('warn', event, message, data);
    },
    error(event, message, data) {
      return write('error', event, message, data);
    },
    close() {
      return queue;
    },
  };
}
