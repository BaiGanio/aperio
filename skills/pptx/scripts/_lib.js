/**
 * Shared helpers for pptx skill scripts.
 *
 * Goals:
 *   - Every script wraps its body in runScript() so uncaught errors produce
 *     a single structured line on stderr (name, message, stack) and exit 1.
 *   - Every script that writes a file verifies the write hit disk and emits
 *     an APERIO_PPTX:{...} marker on stdout. The agent layer parses this
 *     marker, re-stats the file, and either surfaces a generated_file event
 *     to the UI or rewrites the tool result to a hard "file not found" so
 *     the model cannot claim success when nothing was written.
 *
 *   - Read-only scripts (read/thumbnail) only need runScript().
 */

import { statSync, existsSync } from "fs";
import { resolve } from "path";

const MARKER = "APERIO_PPTX:";

export async function runScript(name, fn) {
  try {
    await fn();
  } catch (err) {
    const payload = {
      script: name,
      error: err?.message || String(err),
      code: err?.code || null,
      stack: err?.stack || null,
    };
    process.stderr.write(`❌ [pptx/${name}] ${payload.error}\n`);
    process.stderr.write(`PPTX_ERROR:${JSON.stringify(payload)}\n`);
    process.exit(1);
  }
}

export function verifyOutput(path, { minBytes = 1 } = {}) {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    const err = new Error(`Expected output not on disk: ${abs}`);
    err.code = "OUTPUT_MISSING";
    throw err;
  }
  const st = statSync(abs);
  if (!st.isFile()) {
    const err = new Error(`Expected output is not a regular file: ${abs}`);
    err.code = "OUTPUT_NOT_FILE";
    throw err;
  }
  if (st.size < minBytes) {
    const err = new Error(`Output too small (${st.size} bytes, min ${minBytes}): ${abs}`);
    err.code = "OUTPUT_TOO_SMALL";
    throw err;
  }
  return { abs, size: st.size, mtime: st.mtimeMs };
}

export function emitResult(action, target, extra = {}) {
  const { abs, size } = verifyOutput(target, extra);
  const payload = { action, path: abs, size, ...extra };
  console.log(`✅ ${action}: ${abs} (${size} bytes)`);
  console.log(`${MARKER}${JSON.stringify(payload)}`);
  return payload;
}

export function requireArg(value, usage) {
  if (!value) {
    const err = new Error(`Missing argument. ${usage}`);
    err.code = "BAD_USAGE";
    throw err;
  }
  return value;
}

export function assertExists(path, label = "input") {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    const err = new Error(`${label} not found: ${abs}`);
    err.code = "INPUT_MISSING";
    throw err;
  }
  return abs;
}
