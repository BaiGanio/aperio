import { createLogger, format, transports } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { mkdirSync, readdirSync, statSync, unlinkSync, appendFileSync } from 'fs';
import { join } from 'path';

const isTest = process.env.NODE_ENV === 'test';
const LOG_DIR = 'var/logs';
const CWD = process.cwd();

if (!isTest) {
  mkdirSync(LOG_DIR, { recursive: true });
  // Remove empty log files left by date rotations or sessions with no errors.
  try {
    for (const f of readdirSync(LOG_DIR)) {
      if (/^error-\d{4}-\d{2}-\d{2}\.log$/.test(f) && statSync(join(LOG_DIR, f)).size === 0)
        unlinkSync(join(LOG_DIR, f));
    }
  } catch { /* best-effort */ }
}

const RETENTION = process.env.APERIO_LOG_RETENTION || '30d';

// Capture the call site (relative file:line) for error-level entries only.
const callerFormat = format((info) => {
  if (info.level !== 'error') return info;
  const stack = new Error().stack?.split('\n') ?? [];
  const frame = stack.find(line =>
    line.includes('.js:') &&
    !line.includes('logger.js') &&
    !line.includes('/winston') &&
    !line.includes('/logform/') &&
    !line.includes('node:internal') &&
    !line.includes('node:async') &&
    !line.includes('node:')
  );
  if (frame) {
    const m = frame.match(/\(?((?:file:\/\/)?\/[^)]+:\d+:\d+)\)?/);
    if (m) info.caller = m[1].replace(/^file:\/\//, '').replace(CWD + '/', '');
  }
  return info;
})();

// Write a session banner the first time an error is logged in this process.
// This keeps the log file from being created at all if nothing goes wrong.
let sessionBannerWritten = false;
const sessionBannerFormat = format((info) => {
  if (isTest || sessionBannerWritten) return info;
  sessionBannerWritten = true;
  const today = new Date().toISOString().slice(0, 10);
  const banner = JSON.stringify({
    level: 'SESSION_START',
    pid: process.pid,
    timestamp: new Date().toISOString().replace('T', ' ').slice(0, 23),
  }) + '\n';
  try { appendFileSync(join(LOG_DIR, `error-${today}.log`), banner); } catch { /* best-effort */ }
  return info;
})();

const fileTransports = isTest ? [] : [
  new DailyRotateFile({
    filename:      `${LOG_DIR}/error-%DATE%.log`,
    datePattern:   'YYYY-MM-DD',
    level:         'error',
    maxFiles:      RETENTION,
    zippedArchive: false,
    handleExceptions: true,
    handleRejections: true,
    auditFile:     `${LOG_DIR}/.error-audit.json`,
  }),
];

const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    format.errors({ stack: true }),
    callerFormat,
    sessionBannerFormat,
    format.json()
  ),
  transports: [
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf(({ level, message, timestamp, stack, caller, ...meta }) => {
          const rest = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
          const trail = stack ? `\n${stack}` : '';
          const src = caller ? ` (${caller})` : '';
          return `${timestamp} [${level}]${src}: ${message}${rest}${trail}`;
        })
      )
    }),
    ...fileTransports,
  ],
  exitOnError: false,
});

/**
 * @param {string}   msg
 * @param {unknown}  err
 * @param {object=}  meta
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
