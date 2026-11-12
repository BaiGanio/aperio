// src/server/http-app.js - static files from public/ and the one shared schema
// file, every response with the CSP header (spec S2.14 §2.2, L-C11).
//
// v1 used Express + helmet for this. v2 needs one header and two routes, so it
// is a plain node:http handler: no dependency, no inline code allowed (CSP).
// Paths: decoded, joined under the root, then the realpath must still be inside
// it (isInside from src/files/paths.js), so `..` and symlinks cannot leave.

import { realpath, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { isInside } from '../files/paths.js';

export const CSP_HEADER = "default-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

/** The one file outside public/ the browser may load: the browser imports the same schema the server does (AP8). */
export const SCHEMA_ROUTE = '/shared/ws-schema.js';
const SCHEMA_FILE = path.resolve(import.meta.dirname, '..', 'shared', 'ws-schema.js');
export const DEFAULT_PUBLIC_DIR = path.resolve(import.meta.dirname, '..', '..', 'public');

const TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
});

/**
 * @param {{ publicDir?: string, log: { error: Function } }} opts
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createHttpHandler({ publicDir = DEFAULT_PUBLIC_DIR, log }) {
  return (req, res) => {
    serve(req, res, publicDir).catch((err) => {
      log.error(`[http] ${req.method} failed: ${err.message}`);
      if (!res.headersSent) send(res, 500, 'Internal error');
      else res.destroy();
    });
  };
}

async function serve(req, res, publicDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { allow: 'GET, HEAD' });
  const rawPath = (req.url ?? '/').split('?')[0];
  if (rawPath === SCHEMA_ROUTE) return sendFile(req, res, SCHEMA_FILE);

  let rel;
  try {
    rel = decodeURIComponent(rawPath);
  } catch {
    return send(res, 400, 'Bad request'); // a malformed %-escape is the client's error, answered here
  }
  if (rel.includes('\0') || rel.includes('\\')) return send(res, 400, 'Bad request');
  if (rel.endsWith('/')) rel += 'index.html';

  const file = await resolveInside(publicDir, rel);
  if (file === 'outside') return send(res, 403, 'Forbidden');
  if (!file) return send(res, 404, 'Not found');
  return sendFile(req, res, file);
}

/** @returns {Promise<string | null | 'outside'>} the real file, null when there is none, 'outside' when it leaves the root */
async function resolveInside(root, rel) {
  const joined = path.join(root, rel);
  if (!isInside(joined, root)) return 'outside';
  let real;
  let realRoot;
  try {
    [real, realRoot] = await Promise.all([realpath(joined), realpath(root)]);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
  if (!isInside(real, realRoot)) return 'outside';
  return (await stat(real)).isFile() ? real : null;
}

async function sendFile(req, res, file) {
  const body = await readFile(file);
  const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'content-security-policy': CSP_HEADER });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function send(res, status, text, extra = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-security-policy': CSP_HEADER, ...extra });
  res.end(text);
}
