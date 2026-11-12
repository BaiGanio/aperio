// src/files/paths.js - the one file gate (spec S2.9). FRAGILE ZONE: a bug here
// is a security bug.
//
// The rule: open first, then prove the open handle is inside an allowed folder
// (realpath inside + same dev/ino as the handle), then read or write only
// through that handle. A path swapped between the check and the use is caught
// by the proof (L-C21, AP3). Async only (AP4), no module state (AP6), never
// throws - every failure is { ok: false, code, message } and logged (AP5).
//
// Known limits (spec §2): a hard link inside an allowed folder to an outside
// file passes; in create mode a parent swapped in the gap can leave an empty
// file outside. Plain Node has no openat / O_RESOLVE_BENEATH.

import { open, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

const O_NONBLOCK = constants.O_NONBLOCK ?? 0; // undefined on win32

const DENIED_BASENAMES = new Set([
  '.npmrc', '.netrc', '.pgpass', '.htpasswd', '.dockercfg',
  '.git-credentials', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
]);
const DENIED_EXTENSIONS = new Set(['.pem', '.key', '.pfx', '.p12', '.keystore']);

/** Bare `~` or `~/...` expands to home; `~user/...` is left alone (v1 PATH-01). @param {string} p */
export function expandTilde(p) {
  return p.replace(/^~(?=[\\/]|$)/, homedir());
}

/**
 * True when `real` is `root` or below it. Both must already be realpaths.
 * Pure; `pathImpl` lets tests run the win32 rules on any host (#528).
 * @param {string} real @param {string} root @param {path.PlatformPath} [pathImpl]
 */
export function isInside(real, root, pathImpl = path) {
  const rel = pathImpl.relative(root, real);
  if (rel === '') return true;
  if (pathImpl.isAbsolute(rel)) return false; // other drive or UNC share
  return rel !== '..' && !rel.startsWith(`..${pathImpl.sep}`);
}

/** @param {string} p */
function isSecretFile(p) {
  const base = path.basename(p).toLowerCase();
  if (base.startsWith('.env')) return true;
  return DENIED_BASENAMES.has(base) || DENIED_EXTENSIONS.has(path.extname(base));
}

/** @typedef {{ ok: false, code: string, message: string }} GateError */
/** @typedef {{ debug: Function, info: Function, warn: Function, error: Function }} Log */

/** @param {Log} log @param {string} code @param {unknown} input @param {string} message @returns {GateError} */
function fail(log, code, input, message) {
  log.warn(`[files] ${code}: ${JSON.stringify(String(input))}`);
  return { ok: false, code, message };
}

/** @param {unknown} p @returns {string | null} why the path is unusable, or null */
function badPath(p) {
  if (typeof p !== 'string' || p.trim() === '') return 'Give a non-empty path.';
  if (p.includes('\0')) return 'The path contains a null byte.';
  if (/^[\\/]{2}[?.][\\/]/.test(p)) return 'Device paths (\\\\?\\, \\\\.\\) are not allowed.';
  return null;
}

/** Allowed folders, read from the config the caller passes now (TR15). @param {Record<string, unknown>} config @param {Log} log */
async function allowedRoots(config, log) {
  const raw = String(config.APERIO_ALLOWED_PATHS ?? '');
  const roots = [];
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const p = expandTilde(entry);
    if (!path.isAbsolute(p)) { log.warn(`[files] allowed folder skipped, not absolute: ${entry}`); continue; }
    try {
      roots.push(await realpath(p));
    } catch (err) {
      log.warn(`[files] allowed folder skipped: ${entry} (${/** @type {any} */ (err).code})`);
    }
  }
  return roots;
}

/** realpath of the longest existing prefix, plus the missing tail. @param {string} p @returns {Promise<{ real: string, exists: boolean }>} */
async function realpathLoose(p) {
  try {
    return { real: await realpath(p), exists: true };
  } catch (err) {
    const code = /** @type {any} */ (err).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
    const parent = path.dirname(p);
    if (parent === p) return { real: p, exists: false };
    const up = await realpathLoose(parent);
    return { real: path.join(up.real, path.basename(p)), exists: false };
  }
}

/** @param {string} real @param {string[]} roots */
const insideAny = (real, roots) => roots.some((root) => isInside(real, root));

/**
 * The proof: the path's realpath is inside AND is the very file the handle holds.
 * @param {string} p @param {import('node:fs').BigIntStats} held @param {string[]} roots
 * @returns {Promise<string | null>} the real path, or null when the proof fails
 */
async function prove(p, held, roots) {
  let real;
  try {
    real = await realpath(p);
  } catch (err) {
    if (/** @type {any} */ (err).code === 'ENOENT') return null; // gone since the open
    throw err;
  }
  if (!insideAny(real, roots)) return null;
  const now = await stat(real, { bigint: true });
  return now.dev === held.dev && now.ino === held.ino ? real : null;
}

/** Shared prelude: input, roots, absolute path. */
async function prepare(input, config, log) {
  const why = badPath(input);
  if (why) return { error: fail(log, 'E_BAD_PATH', input, why) };
  const roots = await allowedRoots(config, log);
  if (!roots.length) {
    return { error: fail(log, 'E_NO_ALLOWED_DIRS', input, 'No folder is allowed. Set APERIO_ALLOWED_PATHS.') };
  }
  const p = expandTilde(/** @type {string} */ (input));
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(roots[0], p);
  return { roots, abs };
}

const notAllowed = (log, input, roots) =>
  fail(log, 'E_NOT_ALLOWED', input, `Not allowed: ${input}. Allowed folders: ${roots.join(', ')}`);

/** Map an fs error to a gate error. @param {Log} log @param {unknown} input @param {any} err */
function ioError(log, input, err) {
  if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return fail(log, 'E_NOT_FOUND', input, `Not found: ${input}`);
  if (err?.code === 'EISDIR' || err?.code === 'ENXIO') return fail(log, 'E_NOT_FILE', input, `Not a regular file: ${input}`);
  if (err?.code === 'EEXIST') return fail(log, 'E_EXISTS', input, `Already exists: ${input}. Use mode "overwrite".`);
  return fail(log, 'E_IO', input, `File error (${err?.code ?? err?.message}): ${input}`);
}

/** @param {import('node:fs/promises').FileHandle | undefined} fh @param {Log} log */
async function closeQuietly(fh, log) {
  if (!fh) return;
  try {
    await fh.close();
  } catch (err) { // cleanup
    log.warn(`[files] close failed: ${/** @type {any} */ (err).message}`);
  }
}

/**
 * Read a UTF-8 text file, only if it is really inside an allowed folder.
 * @param {unknown} input
 * @param {{ config: Record<string, any>, log: Log, hooks?: { beforeOpen?: Function, afterOpen?: Function } }} opts
 */
export async function gatedRead(input, { config, log, hooks = {} }) {
  const prep = await prepare(input, config, log);
  if (prep.error) return prep.error;
  const { roots, abs } = prep;
  const max = Number(config.FILE_READ_MAX_BYTES);
  let fh;
  try {
    const pre = await realpathLoose(abs); // fast deny only; the proof below is the gate
    if (!insideAny(pre.real, roots)) return notAllowed(log, input, roots);
    if (!pre.exists) return fail(log, 'E_NOT_FOUND', input, `Not found: ${input}`);
    if (isSecretFile(abs) || isSecretFile(pre.real)) return fail(log, 'E_SECRET', input, `Secret or credential files are not allowed: ${path.basename(abs)}`);

    await hooks.beforeOpen?.();
    fh = await open(abs, constants.O_RDONLY | O_NONBLOCK);
    await hooks.afterOpen?.(fh);
    const held = await fh.stat({ bigint: true });
    if (!held.isFile()) return fail(log, 'E_NOT_FILE', input, `Not a regular file: ${input}`);
    const real = await prove(abs, held, roots);
    if (!real) return fail(log, 'E_SWAPPED', input, `The path changed while it was opened: ${input}`);
    if (isSecretFile(real)) return fail(log, 'E_SECRET', input, `Secret or credential files are not allowed: ${path.basename(real)}`);
    if (held.size > BigInt(max)) return fail(log, 'E_TOO_LARGE', input, `File too large (${held.size} bytes). Max ${max}.`);

    const buf = Buffer.alloc(Math.min(Number(held.size), max) + 1);
    let bytes = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, bytes, buf.length - bytes, bytes);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > max) return fail(log, 'E_TOO_LARGE', input, `File too large (over ${max} bytes).`);
      if (bytes === buf.length) break;
    }
    return { ok: true, text: buf.subarray(0, bytes).toString('utf8'), realPath: real, bytes };
  } catch (err) {
    return ioError(log, input, err);
  } finally {
    await closeQuietly(fh, log);
  }
}

/**
 * Write UTF-8 text, only into a file that is really inside an allowed folder.
 * mode 'create': the parent must exist, the file must not. mode 'overwrite': the file must exist.
 * @param {unknown} input @param {unknown} text
 * @param {{ mode: 'create' | 'overwrite', config: Record<string, any>, log: Log, hooks?: { beforeOpen?: Function, afterOpen?: Function } }} opts
 */
export async function gatedWrite(input, text, { mode, config, log, hooks = {} }) {
  const prep = await prepare(input, config, log);
  if (prep.error) return prep.error;
  const { roots, abs } = prep;
  if (mode !== 'create' && mode !== 'overwrite') return fail(log, 'E_BAD_ARGS', input, 'mode must be "create" or "overwrite".');
  if (typeof text !== 'string') return fail(log, 'E_BAD_ARGS', input, 'Content must be text.');
  const data = Buffer.from(text, 'utf8');
  const max = Number(config.FILE_WRITE_MAX_BYTES);
  if (data.length > max) return fail(log, 'E_TOO_LARGE', input, `Content too large (${data.length} bytes). Max ${max}.`);
  if (isSecretFile(abs)) return fail(log, 'E_SECRET', input, `Secret or credential files are not allowed: ${path.basename(abs)}`);

  let fh;
  try {
    let target;
    if (mode === 'create') {
      const parent = await realpathLoose(path.dirname(abs));
      if (!insideAny(parent.real, roots)) return notAllowed(log, input, roots);
      if (!parent.exists) return fail(log, 'E_NOT_FOUND', input, `Folder not found: ${path.dirname(abs)}`);
      target = path.join(parent.real, path.basename(abs));
      await hooks.beforeOpen?.();
      fh = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    } else {
      const pre = await realpathLoose(abs);
      if (!insideAny(pre.real, roots)) return notAllowed(log, input, roots);
      if (!pre.exists) return fail(log, 'E_NOT_FOUND', input, `Not found: ${input}`);
      if (isSecretFile(pre.real)) return fail(log, 'E_SECRET', input, `Secret or credential files are not allowed: ${path.basename(pre.real)}`);
      target = abs;
      await hooks.beforeOpen?.();
      fh = await open(target, constants.O_WRONLY | O_NONBLOCK); // no O_TRUNC before the proof
    }
    await hooks.afterOpen?.(fh);
    const held = await fh.stat({ bigint: true });
    if (!held.isFile()) return fail(log, 'E_NOT_FILE', input, `Not a regular file: ${input}`);
    const real = await prove(target, held, roots);
    if (!real) return fail(log, 'E_SWAPPED', input, `The path changed while it was opened: ${input}`);
    if (isSecretFile(real)) return fail(log, 'E_SECRET', input, `Secret or credential files are not allowed: ${path.basename(real)}`);

    await fh.truncate(0);
    let written = 0;
    while (written < data.length) {
      const { bytesWritten } = await fh.write(data, written, data.length - written, written);
      written += bytesWritten;
    }
    return { ok: true, realPath: real, bytes: data.length, created: mode === 'create' };
  } catch (err) {
    return ioError(log, input, err);
  } finally {
    await closeQuietly(fh, log);
  }
}
