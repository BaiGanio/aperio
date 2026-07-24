import { closeSync, existsSync, openSync, readSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, join, resolve } from "path";

const GIB = 1024 ** 3;
const GGUF_TYPES = { UINT8: 0, INT8: 1, UINT16: 2, INT16: 3, UINT32: 4, INT32: 5, FLOAT32: 6, BOOL: 7, STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12 };
const FIXED_BYTES = new Map([[0, 1], [1, 1], [2, 2], [3, 2], [4, 4], [5, 4], [6, 4], [7, 1], [10, 8], [11, 8], [12, 8]]);

class Reader {
  constructor(fd) { this.fd = fd; this.pos = 0; }
  bytes(n) { const b = Buffer.allocUnsafe(n); const got = readSync(this.fd, b, 0, n, this.pos); if (got !== n) throw new Error("truncated GGUF header"); this.pos += n; return b; }
  u32() { return this.bytes(4).readUInt32LE(); }
  u64() { const n = this.bytes(8).readBigUInt64LE(); if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("GGUF integer exceeds safe range"); return Number(n); }
  str() { return this.bytes(this.u64()).toString("utf8"); }
  scalar(type) {
    const b = this.bytes(FIXED_BYTES.get(type));
    if (type === GGUF_TYPES.UINT8) return b.readUInt8();
    if (type === GGUF_TYPES.INT8) return b.readInt8();
    if (type === GGUF_TYPES.UINT16) return b.readUInt16LE();
    if (type === GGUF_TYPES.INT16) return b.readInt16LE();
    if (type === GGUF_TYPES.UINT32) return b.readUInt32LE();
    if (type === GGUF_TYPES.INT32) return b.readInt32LE();
    if (type === GGUF_TYPES.FLOAT32) return b.readFloatLE();
    if (type === GGUF_TYPES.BOOL) return b.readUInt8() !== 0;
    if (type === GGUF_TYPES.UINT64) return Number(b.readBigUInt64LE());
    if (type === GGUF_TYPES.INT64) return Number(b.readBigInt64LE());
    if (type === GGUF_TYPES.FLOAT64) return b.readDoubleLE();
    throw new Error(`unsupported GGUF scalar type ${type}`);
  }
  value(type, keep = true) {
    if (type === GGUF_TYPES.STRING) { const v = this.str(); return keep ? v : undefined; }
    if (type === GGUF_TYPES.ARRAY) {
      const itemType = this.u32(); const count = this.u64();
      if (FIXED_BYTES.has(itemType)) {
        if (keep && count <= 64) { const out = []; for (let i = 0; i < count; i++) out.push(this.scalar(itemType)); return out; }
        this.pos += FIXED_BYTES.get(itemType) * count; return undefined;
      }
      const out = keep && count <= 64 ? [] : null;
      for (let i = 0; i < count; i++) { const v = this.value(itemType, out !== null); if (out) out.push(v); }
      return out ?? undefined;
    }
    return this.scalar(type);
  }
}

const RELEVANT_SUFFIXES = ["block_count", "context_length", "embedding_length", "attention.head_count", "attention.head_count_kv", "attention.key_length", "attention.value_length", "attention.sliding_window", "full_attention_interval", "expert_count", "expert_used_count"];

export function readGgufMetadata(path) {
  const fd = openSync(path, "r");
  try {
    const r = new Reader(fd);
    if (r.bytes(4).toString("ascii") !== "GGUF") throw new Error("not a GGUF file");
    const version = r.u32(); if (version < 2 || version > 3) throw new Error(`unsupported GGUF version ${version}`);
    r.u64(); // tensor count
    const kvCount = r.u64();
    const meta = {};
    for (let i = 0; i < kvCount; i++) {
      const key = r.str(); const type = r.u32();
      const keep = key === "general.architecture" || RELEVANT_SUFFIXES.some(s => key.endsWith(`.${s}`));
      const value = r.value(type, keep);
      if (keep) meta[key] = value;
    }
    return meta;
  } finally { closeSync(fd); }
}

export function factsFromGguf(path) {
  const meta = readGgufMetadata(path);
  const arch = meta["general.architecture"];
  if (!arch) return null;
  const g = suffix => meta[`${arch}.${suffix}`];
  const blocks = Number(g("block_count"));
  const interval = Number(g("full_attention_interval")) || 1;
  const kvLayers = interval > 1 ? Math.ceil(blocks / interval) : blocks;
  const heads = Number(g("attention.head_count"));
  const kvHeadMeta = g("attention.head_count_kv") ?? heads;
  const embed = Number(g("embedding_length"));
  const keyDim = Number(g("attention.key_length") ?? (embed && heads ? embed / heads : 0));
  const valueDim = Number(g("attention.value_length") ?? keyDim);
  if (!blocks || !keyDim || !valueDim) return null;
  let kvBytesPerToken;
  let kvFixedGB = 0;
  if (Array.isArray(kvHeadMeta)) {
    const perLayer = kvHeadMeta.map(Number).filter(Number.isFinite);
    if (!perLayer.length) return null;
    const slidingWindow = Number(g("attention.sliding_window")) || 0;
    if (slidingWindow > 0) {
      // Gemma-style mixed attention declares fewer KV heads on its periodic
      // global layers and more on local sliding layers. Local cache stops
      // growing at slidingWindow; only global heads grow with full context.
      const globalHeads = Math.min(...perLayer.filter(n => n > 0));
      const globalSum = perLayer.filter(n => n === globalHeads).reduce((a, n) => a + n, 0);
      const slidingSum = perLayer.filter(n => n !== globalHeads).reduce((a, n) => a + n, 0);
      kvBytesPerToken = globalSum * (keyDim + valueDim) * 2;
      kvFixedGB = slidingSum * slidingWindow * (keyDim + valueDim) * 2 / GIB;
    } else {
      kvBytesPerToken = perLayer.reduce((a, n) => a + n, 0) * (keyDim + valueDim) * 2;
    }
  } else {
    const kvHeads = Number(kvHeadMeta);
    if (!kvHeads) return null;
    kvBytesPerToken = kvLayers * kvHeads * (keyDim + valueDim) * 2;
  }
  return {
    sizeGB: statSync(path).size / GIB,
    maxContext: Number(g("context_length")) || 32768,
    kvBytesPerToken,
    kvFixedGB,
    architecture: Number(g("expert_count")) > 0 ? "moe" : "dense",
    source: "gguf",
    path,
    kvLayers,
  };
}

function repoCacheDir(model, cacheRoot) {
  const repo = String(model).split(":")[0];
  if (!repo.includes("/")) return null;
  return join(cacheRoot, "models--" + repo.replaceAll("/", "--"));
}

export function findCachedGguf(model, cacheRoot) {
  if (String(model).toLowerCase().endsWith(".gguf") && existsSync(model)) return resolve(model);
  const root = repoCacheDir(model, cacheRoot); if (!root) return null;
  let revision;
  try { revision = readFileSync(join(root, "refs", "main"), "utf8").trim(); } catch { return null; }
  const snapshot = join(root, "snapshots", revision);
  let files;
  try { files = readdirSync(snapshot).filter(f => /\.gguf$/i.test(f) && !/^mmproj/i.test(f)); } catch { return null; }
  if (!files.length) return null;
  const quant = String(model).split(":")[1]?.toLowerCase();
  if (quant) {
    const matches = files.filter(f => f.toLowerCase().includes(quant));
    if (matches.length) files = matches;
  }
  files.sort((a, b) => statSync(join(snapshot, b)).size - statSync(join(snapshot, a)).size);
  return join(snapshot, files[0]);
}

export function inspectCachedModel(model, cacheRoot) {
  const path = findCachedGguf(model, cacheRoot);
  if (!path) return null;
  try {
    const facts = factsFromGguf(path);
    if (!facts) return null;
    // Metadata is repeated in every split GGUF shard, but the weight footprint
    // is the sum of the complete shard family.
    const file = basename(path);
    const split = file.match(/^(.*)-\d{5}-of-(\d{5})(\.gguf)$/i);
    if (split) {
      const [, prefix, countText, suffix] = split;
      const expected = Number(countText);
      const dir = resolve(path, "..");
      const siblings = readdirSync(dir).filter(name =>
        name.startsWith(`${prefix}-`) && name.endsWith(`-of-${countText}${suffix}`),
      );
      if (siblings.length === expected) {
        facts.sizeGB = siblings.reduce((sum, name) => sum + statSync(join(dir, name)).size, 0) / GIB;
      }
    }
    return facts;
  } catch { return null; }
}
