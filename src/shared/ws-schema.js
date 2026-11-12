// src/shared/ws-schema.js - every WebSocket message and its fields (spec S2.11, AP8).
//
// Fragile zone: the server and the browser import this same file, with no build.
// So: pure ESM, no imports, no state, no Node-only globals. The server reads
// WS_MAX_FRAME_BYTES from config and passes it in as `maxBytes`.

/** @typedef {'string' | 'int' | 'number' | 'bool' | 'object' | 'array'} Kind */
/** @typedef {{ kind: Kind, required?: boolean, max?: number }} FieldSpec */
/** @typedef {{ code: string, message: string, type?: string }} FrameError */

export const DEFAULT_MAX_FRAME_BYTES = 256 * 1024;
/** Server frames carry whole answers and memory lists: bounded, not tight (16 MiB). */
export const DEFAULT_MAX_SERVER_FRAME_BYTES = 16 * 1024 * 1024;

const TEXT_MAX = 1 << 20; // server text (a whole answer) - bounded, not tight
/** @param {Kind} kind @param {number} [max] @returns {FieldSpec} */
const req = (kind, max) => ({ kind, required: true, ...(max ? { max } : {}) });
/** @param {Kind} kind @param {number} [max] @returns {FieldSpec} */
const opt = (kind, max) => ({ kind, ...(max ? { max } : {}) });
const TURN_ID = 128;
/** @param {Record<string, Record<string, FieldSpec>>} table @returns {Readonly<Record<string, Readonly<Record<string, FieldSpec>>>>} */
const freezeAll = (table) => Object.freeze(Object.fromEntries(Object.entries(table).map(
  ([type, fields]) => [type, Object.freeze(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, Object.freeze(v)])))])));

/** @type {Readonly<Record<string, Readonly<Record<string, FieldSpec>>>>} */
export const CLIENT_TYPES = freezeAll({
  chat: { turnId: req('string', TURN_ID), text: req('string', DEFAULT_MAX_FRAME_BYTES) },
  stop: { turnId: opt('string', TURN_ID) },
  memories_list: {},
  memory_update: { id: req('string', 64), content: req('string', 16384) },
  memory_delete: { id: req('string', 64) },
});

const T = { turnId: opt('string', TURN_ID) };
/** @type {Readonly<Record<string, Readonly<Record<string, FieldSpec>>>>} */
export const SERVER_TYPES = freezeAll({
  stream_start: { ...T },
  token: { ...T, text: req('string', TEXT_MAX) },
  reasoning_token: { ...T, text: req('string', TEXT_MAX) },
  tool_start: { ...T, id: req('string', 256), name: req('string', 128), arguments: opt('object') },
  tool_result: { ...T, id: req('string', 256), name: req('string', 128), ok: req('bool') },
  tool_args_invalid: { ...T, id: req('string', 256), name: req('string', 128), raw: opt('string', TEXT_MAX), message: req('string', 2000) },
  retract: { ...T, reason: req('string', 64) },
  stream_end: { ...T, text: opt('string', TEXT_MAX), toolCalls: opt('array', 64), aborted: opt('bool') },
  recall_injected: { ...T, rows: req('array', 64), tokens: req('int'), ms: req('number') },
  recall_skipped: { ...T, reason: req('string', 256) },
  context_trimmed: { ...T, dropped: req('int'), pct: req('int') },
  turn_complete: { ...T, status: req('string', 16) },
  error: { ...T, code: opt('string', 32), kind: opt('string', 64), message: req('string', 2000) },
  memories: { ...T, rows: req('array', 1000) },
});

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** @type {Record<Kind, (v: unknown) => boolean>} */
const KIND_OK = {
  string: (v) => typeof v === 'string', int: Number.isInteger, bool: (v) => typeof v === 'boolean',
  number: (v) => typeof v === 'number' && Number.isFinite(v), object: isPlainObject, array: Array.isArray,
};
const SAFE_NAME = /^[A-Za-z_]\w{0,31}$/;

/**
 * Check msg's fields against a type. Returns an error or null. Never echoes a value.
 * @param {string} type @param {Readonly<Record<string, FieldSpec>>} fields @param {Record<string, unknown>} msg
 * @returns {FrameError | null}
 */
function checkFields(type, fields, msg) {
  for (const key of Object.keys(msg)) {
    if (key === 'type' || Object.hasOwn(fields, key)) continue;
    const shown = SAFE_NAME.test(key) ? key : '<field>';
    return { code: 'extra_field', type, message: `${type}.${shown}: not a field of ${type}` };
  }
  for (const [name, spec] of Object.entries(fields)) {
    const v = msg[name];
    if (v === undefined) {
      if (spec.required) return { code: 'missing_field', type, message: `${type}.${name}: is required` };
      continue;
    }
    if (!KIND_OK[spec.kind](v)) return { code: 'bad_field', type, message: `${type}.${name}: must be ${spec.kind === 'int' ? 'an' : 'a'} ${spec.kind}` };
    if (spec.max !== undefined && /** @type {string | unknown[]} */ (v).length > spec.max) {
      return { code: 'bad_field', type, message: `${type}.${name}: longer than ${spec.max}` };
    }
  }
  return null;
}

/** UTF-8 byte length, without encoding when the char count already decides. @param {string} s @param {number} max */
function byteLength(s, max) {
  if (s.length > max) return s.length;
  if (s.length * 3 <= max) return s.length;
  return new TextEncoder().encode(s).length;
}

/**
 * Decode, size-check and JSON-parse one frame, then check it against `table`. Never throws.
 * @param {unknown} raw @param {Readonly<Record<string, Readonly<Record<string, FieldSpec>>>>} table @param {number} maxBytes
 * @returns {{ ok: true, msg: Record<string, unknown> } | { ok: false, error: FrameError }}
 */
function parseFrame(raw, table, maxBytes) {
  /** @param {string} code @param {string} message */
  const reject = (code, message) => ({ ok: /** @type {const} */ (false), error: { code, message } });
  let text;
  if (typeof raw === 'string') {
    if (byteLength(raw, maxBytes) > maxBytes) return reject('too_large', `frame is larger than ${maxBytes} bytes`);
    text = raw;
  } else if (raw instanceof Uint8Array) {
    if (raw.byteLength > maxBytes) return reject('too_large', `frame is larger than ${maxBytes} bytes`);
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      return reject('bad_json', 'frame is not valid UTF-8');
    }
  } else {
    return reject('bad_json', 'frame is not text');
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return reject('bad_json', 'frame is not valid JSON');
  }
  if (!isPlainObject(data)) return reject('not_object', 'frame must be a JSON object');
  const { type } = data;
  if (typeof type !== 'string' || !Object.hasOwn(table, type)) return reject('unknown_type', 'unknown message type');

  const fields = table[type];
  const err = checkFields(type, fields, data);
  if (err) return { ok: false, error: err };
  /** @type {Record<string, unknown>} */
  const msg = { type };
  for (const name of Object.keys(fields)) if (data[name] !== undefined) msg[name] = data[name];
  return { ok: true, msg };
}

/**
 * Check msg against `table` and serialise it. A bad message is a bug on the
 * sending side: it throws, it is never sent.
 * @param {unknown} msg @param {Readonly<Record<string, Readonly<Record<string, FieldSpec>>>>} table @param {string} side
 * @returns {string}
 */
function encodeFrame(msg, table, side) {
  const type = isPlainObject(msg) ? /** @type {Record<string, unknown>} */ (msg).type : undefined;
  if (typeof type !== 'string' || !Object.hasOwn(table, type)) {
    throw new TypeError(`ws-schema: unknown ${side} frame type ${JSON.stringify(type)}`);
  }
  const err = checkFields(type, table[type], /** @type {Record<string, unknown>} */ (msg));
  if (err) throw new TypeError(`ws-schema: ${err.message}`);
  return JSON.stringify(msg);
}

/**
 * Check one client frame at the socket edge, once. Never throws.
 * @param {string | Uint8Array} raw
 * @param {{ maxBytes?: number }} [opts]  the server passes config WS_MAX_FRAME_BYTES
 * @returns {{ ok: true, msg: Record<string, unknown> } | { ok: false, error: FrameError }}
 */
export function parseClientFrame(raw, { maxBytes = DEFAULT_MAX_FRAME_BYTES } = {}) {
  return parseFrame(raw, CLIENT_TYPES, maxBytes);
}

/**
 * Check one server frame in the browser, once (spec S3.0 §4.1). Never throws;
 * same error codes as parseClientFrame.
 * @param {unknown} raw
 * @param {{ maxBytes?: number }} [opts]
 * @returns {{ ok: true, msg: Record<string, unknown> } | { ok: false, error: FrameError }}
 */
export function parseServerFrame(raw, { maxBytes = DEFAULT_MAX_SERVER_FRAME_BYTES } = {}) {
  return parseFrame(raw, SERVER_TYPES, maxBytes);
}

/**
 * Build one client frame (spec S3.0 §4.1). A bad message is a client bug: it throws, never sends.
 * @param {Record<string, unknown>} msg
 * @returns {string}
 */
export function encodeClientFrame(msg) {
  return encodeFrame(msg, CLIENT_TYPES, 'client');
}

/**
 * Build one server frame. A bad message is a server bug: it throws, never sends.
 * @param {Record<string, unknown>} msg
 * @returns {string}
 */
export function encodeServerFrame(msg) {
  return encodeFrame(msg, SERVER_TYPES, 'server');
}
