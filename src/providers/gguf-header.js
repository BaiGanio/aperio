// src/providers/gguf-header.js - read the few GGUF header keys the launcher
// uses (spec S2.5, launcher 2). Async: src/providers/ is not boot code (AP4).
//
// Ported from v1 lib/helpers/ggufModelFacts.js at archive/v1-final: the
// key/value walk (v2 and v3 headers, typed scalars, arrays skipped by size).
// Dropped: the KV-per-token math. Measured 10x too high for a sliding-window
// model (spec §1, L-M09), so v2 reads only arch, context length, block count
// and the chat template - and never sizes context from RAM.

import { open } from 'node:fs/promises';

export class GgufError extends Error {
  /** @param {string} message @param {unknown} [cause] */
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'GgufError';
  }
}

const T = Object.freeze({ U8: 0, I8: 1, U16: 2, I16: 3, U32: 4, I32: 5, F32: 6, BOOL: 7, STRING: 8, ARRAY: 9, U64: 10, I64: 11, F64: 12 });
const FIXED = new Map([[0, 1], [1, 1], [2, 2], [3, 2], [4, 4], [5, 4], [6, 4], [7, 1], [10, 8], [11, 8], [12, 8]]);
const CHUNK = 1 << 20;
/** A header string longer than this is not a real header (stops a bad length from allocating GBs). */
const MAX_STRING = 64 << 20;

/** Buffered forward-only reader over a file handle. */
class HeaderReader {
  /** @param {import('node:fs/promises').FileHandle} fh @param {string} path */
  constructor(fh, path) {
    this.fh = fh;
    this.path = path;
    this.buf = Buffer.alloc(0);
    this.off = 0; // position inside buf
    this.filePos = 0; // file position of buf's end
  }

  async ensure(n) {
    while (this.buf.length - this.off < n) {
      const want = Math.max(CHUNK, n - (this.buf.length - this.off));
      const chunk = Buffer.allocUnsafe(want);
      const { bytesRead } = await this.fh.read(chunk, 0, want, this.filePos);
      if (bytesRead === 0) throw new GgufError(`GGUF header is truncated: ${this.path}`);
      this.filePos += bytesRead;
      this.buf = Buffer.concat([this.buf.subarray(this.off), chunk.subarray(0, bytesRead)]);
      this.off = 0;
    }
  }

  async bytes(n) {
    await this.ensure(n);
    const b = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return b;
  }

  async skip(n) {
    const inBuf = this.buf.length - this.off;
    if (n <= inBuf) { this.off += n; return; }
    this.filePos += n - inBuf;
    this.buf = Buffer.alloc(0);
    this.off = 0;
  }

  async u32() { return (await this.bytes(4)).readUInt32LE(); }

  async u64() {
    const n = (await this.bytes(8)).readBigUInt64LE();
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new GgufError(`GGUF integer too large in ${this.path}`);
    return Number(n);
  }

  async str() {
    const len = await this.u64();
    if (len > MAX_STRING) throw new GgufError(`GGUF string length ${len} is not plausible in ${this.path}`);
    return (await this.bytes(len)).toString('utf8');
  }

  async scalar(type) {
    const size = FIXED.get(type);
    if (size === undefined) throw new GgufError(`unknown GGUF value type ${type} in ${this.path}`);
    const b = await this.bytes(size);
    switch (type) {
      case T.U8: return b.readUInt8();
      case T.I8: return b.readInt8();
      case T.U16: return b.readUInt16LE();
      case T.I16: return b.readInt16LE();
      case T.U32: return b.readUInt32LE();
      case T.I32: return b.readInt32LE();
      case T.F32: return b.readFloatLE();
      case T.BOOL: return b.readUInt8() !== 0;
      case T.U64: return Number(b.readBigUInt64LE());
      case T.I64: return Number(b.readBigInt64LE());
      default: return b.readDoubleLE();
    }
  }

  /** Read a value; arrays are skipped (no key we keep is an array). */
  async value(type) {
    if (type === T.STRING) return this.str();
    if (type !== T.ARRAY) return this.scalar(type);
    const itemType = await this.u32();
    const count = await this.u64();
    const size = FIXED.get(itemType);
    if (size !== undefined) { await this.skip(size * count); return undefined; }
    for (let i = 0; i < count; i++) await this.value(itemType);
    return undefined;
  }
}

/**
 * @typedef {{ arch: string | null, contextLength: number | null, blockCount: number | null,
 *   chatTemplate: string | null }} GgufHeader
 */

/**
 * @param {string} path
 * @returns {Promise<GgufHeader>}
 */
export async function readGgufHeader(path) {
  let fh;
  try {
    fh = await open(path, 'r');
  } catch (err) {
    throw new GgufError(`cannot open GGUF file ${path}: ${err.message}`, err);
  }
  try {
    const r = new HeaderReader(fh, path);
    if ((await r.bytes(4)).toString('ascii') !== 'GGUF') throw new GgufError(`not a GGUF file: ${path}`);
    const version = await r.u32();
    if (version < 2 || version > 3) throw new GgufError(`unsupported GGUF version ${version}: ${path}`);
    await r.u64(); // tensor count
    const kvCount = await r.u64();
    /** @type {Record<string, unknown>} */
    const meta = {};
    for (let i = 0; i < kvCount; i++) {
      const key = await r.str();
      const type = await r.u32();
      const v = await r.value(type);
      if (v !== undefined) meta[key] = v;
    }
    const arch = typeof meta['general.architecture'] === 'string' ? meta['general.architecture'] : null;
    const num = (k) => (arch && typeof meta[`${arch}.${k}`] === 'number' ? /** @type {number} */ (meta[`${arch}.${k}`]) : null);
    const tpl = meta['tokenizer.chat_template'];
    return {
      arch,
      contextLength: num('context_length'),
      blockCount: num('block_count'),
      chatTemplate: typeof tpl === 'string' ? tpl : null,
    };
  } catch (err) {
    if (err instanceof GgufError) throw err;
    throw new GgufError(`cannot read GGUF header ${path}: ${err.message}`, err);
  } finally {
    await fh.close();
  }
}

/**
 * Capabilities from the chat template, never from a model name (AP2).
 * No template: tools assumed (permissive, as v1), thinking off.
 * @param {{ chatTemplate: string | null }} header
 * @returns {{ tools: boolean, thinking: boolean }}
 */
export function capabilitiesFromHeader({ chatTemplate }) {
  if (!chatTemplate) return { tools: true, thinking: false };
  return {
    tools: /\btools\b/.test(chatTemplate),
    thinking: /enable_thinking|<think>|reasoning_content/.test(chatTemplate),
  };
}
