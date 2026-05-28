// lib/helpers/logger.js
// Winston logger with daily-rotated error logs. Files land at
// var/logs/error-YYYY-MM-DD.log, retained for 30 days by default
// (override via APERIO_LOG_RETENTION="14d", "60d", etc.).
//
// Every error log entry includes the full stack trace via format.errors.
// Use logError(msg, err, meta?) to guarantee both message and stack land
// in the file even when callers forget to pass the Error object directly.

import { createLogger, format, transports } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { mkdirSync } from 'fs';
import { join } from 'path';

const isTest = process.env.NODE_ENV === 'test';

if (!isTest) {
  mkdirSync('var/logs', { recursive: true });
}

const RETENTION = process.env.APERIO_LOG_RETENTION || '30d';

const fileTransports = isTest ? [] : [
  new DailyRotateFile({
    filename:    'var/logs/error-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    level:       'error',
    maxFiles:    RETENTION,
    zippedArchive: false,
    handleExceptions:        true,   // uncaught exceptions land here
    handleRejections:        true,   // unhandled promise rejections too
    auditFile:   'var/logs/.error-audit.json',
  }),
];

const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    format.errors({ stack: true }),
    format.json()
  ),
  transports: [
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf(({ level, message, timestamp, stack, ...meta }) => {
          const rest = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
          // Show the stack inline on the console when present.
          const trail = stack ? `\n${stack}` : '';
          return `${timestamp} [${level}]: ${message}${rest}${trail}`;
        })
      )
    }),
    ...fileTransports,
  ],
  // Surface listener-side issues instead of swallowing them.
  exitOnError: false,
});

/**
 * Log an error with a guaranteed full stack trace.
 * Callers were forgetting to pass the Error object directly (winston's
 * format.errors needs the Error instance to extract `.stack`); this helper
 * normalises every callsite into the same shape.
 *
 * @param {string}   msg    — short context line, e.g. "watcher: index failed"
 * @param {unknown}  err    — the caught value (Error preferred, but anything works)
 * @param {object=}  meta   — extra structured fields to attach (file, repo, etc.)
 */
export function logError(msg, err, meta = {}) {
  const message = err instanceof Error ? err.message : String(err);
  const stack   = err instanceof Error ? err.stack   : undefined;
  logger.error(`${msg}: ${message}`, { stack, ...meta });
}

export function createSessionLogger(sessionId, logDir) {
  mkdirSync(logDir, { recursive: true });
  return createLogger({
    level: 'error',
    format: format.combine(
      format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
      format.errors({ stack: true }),
      format.json()
    ),
    transports: [
      new transports.File({ filename: join(logDir, `${sessionId}.log`), level: 'error', lazy: true }),
    ],
  });
}

export default logger;
