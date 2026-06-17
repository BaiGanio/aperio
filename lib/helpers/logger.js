import { createLogger, format, transports } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { mkdirSync, readdirSync, statSync, unlinkSync, appendFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { redactSecrets } from './redactSecrets.js';

const isTest = process.env.NODE_ENV === 'test';
const LOG_DIR = 'var/logs';
const CWD = process.cwd();

if (!isTest) {
  // DATA-01: keep the log dir + files private (0700/0600).
  mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  try { chmodSync(LOG_DIR, 0o700); } catch { /* best-effort */ }
  // Remove empty log files left by date rotations or sessions with no errors;
  // tighten perms on any pre-existing error logs (mode is ignored on create
  // when the file already exists).
  try {
    for (const f of readdirSync(LOG_DIR)) {
      if (!/^error-\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;
      if (statSync(join(LOG_DIR, f)).size === 0) unlinkSync(join(LOG_DIR, f));
      else { try { chmodSync(join(LOG_DIR, f), 0o600); } catch { /* best-effort */ } }
    }
  } catch { /* best-effort */ }
}

// DATA-01: scrub high-confidence secrets out of the message/stack before they
// hit the on-disk log. Applied at the logger level, so it covers the file
// transports (the Console transport has its own format and is terminal-only).
const redactFormat = format((info) => {
  if (typeof info.message === 'string') info.message = redactSecrets(info.message);
  if (typeof info.stack === 'string')   info.stack   = redactSecrets(info.stack);
  return info;
})();

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
// Aperio runs two processes — the main app and a shared MCP subprocess (spawned
// with APERIO_PROC_ROLE=mcp) — so the banner is PROCESS-level, not session-level:
// one MCP process serves every chat session, so it cannot carry a single session
// id. The role + pid identify which process wrote the errors that follow; the
// session id, when relevant, is attached per error line (see mcp/tools/shell.js).
const PROC_ROLE = process.env.APERIO_PROC_ROLE || 'main';
let sessionBannerWritten = false;
const sessionBannerFormat = format((info) => {
  if (isTest || sessionBannerWritten) return info;
  sessionBannerWritten = true;
  const today = new Date().toISOString().slice(0, 10);
  const banner = JSON.stringify({
    level: 'PROCESS_START',
    proc: PROC_ROLE,
    pid: process.pid,
    timestamp: new Date().toISOString().replace('T', ' ').slice(0, 23),
  }) + '\n';
  try { appendFileSync(join(LOG_DIR, `error-${today}.log`), banner, { mode: 0o600 }); } catch { /* best-effort */ }
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
    options:       { flags: 'a', mode: 0o600 },   // DATA-01
  }),
];

const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    format.errors({ stack: true }),
    callerFormat,
    sessionBannerFormat,
    redactFormat,
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
  mkdirSync(logDir, { recursive: true, mode: 0o700 });   // DATA-01
  try { chmodSync(logDir, 0o700); } catch { /* best-effort */ }
  return createLogger({
    level: 'error',
    format: format.combine(
      format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
      format.errors({ stack: true }),
      redactFormat,
      format.json()
    ),
    transports: [
      new transports.File({
        filename: join(logDir, `${sessionId}.log`),
        level: 'error',
        lazy: true,
        options: { flags: 'a', mode: 0o600 },          // DATA-01
      }),
    ],
  });
}

export default logger;
