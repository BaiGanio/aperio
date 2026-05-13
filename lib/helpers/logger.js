import { createLogger, format, transports } from 'winston';
import { mkdirSync } from 'fs';
import { join } from 'path';

mkdirSync('var/logs', { recursive: true });

const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.json()
  ),
  transports: [
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf(({ level, message, timestamp, ...meta }) => {
          return `${timestamp} [${level}]: ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
        })
      )
    }),
    new transports.File({ filename: 'var/logs/error.log', level: 'error', lazy: true }),
  ],
});

export function createSessionLogger(sessionId, logDir) {
  mkdirSync(logDir, { recursive: true });
  return createLogger({
    level: 'error',
    format: format.combine(
      format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      format.errors({ stack: true }),
      format.json()
    ),
    transports: [
      new transports.File({ filename: join(logDir, `${sessionId}.log`), level: 'error', lazy: true }),
    ],
  });
}

export default logger;