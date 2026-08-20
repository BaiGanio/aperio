// Durable T3.3 audit-run ledger.
//
// One JSON object per line keeps run records append-only: recording a new
// slice never rewrites earlier evidence. Reads fail closed on every malformed
// or schema-invalid line, so the accounting gate cannot look green after
// silently discarding a damaged record.

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRun } from "./schema.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const RUN_LEDGER_FILE = join(ROOT, "audit", "ledger", "runs.jsonl");

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function readProviderLoop(provider) {
  if (typeof provider !== "string" || !/^[a-z0-9-]+$/.test(provider)) return null;
  try { return readFileSync(join(ROOT, "lib", "agent", "providers", `${provider}.js`), "utf8"); }
  catch { return null; }
}

function tokenCount(value, field) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`streamUsage.${field} must be a non-negative number, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Translate the provider loops' emitted `streamUsage` shape into the ledger's
 * stable token names. A provider loop that contains the cache-creation field
 * must emit it for this run; absence is never rewritten to zero.
 */
export function tokensFromStreamUsage(streamUsage, provider, {
  loadProviderLoop = readProviderLoop,
} = {}) {
  if (!streamUsage || typeof streamUsage !== "object") {
    throw new Error("streamUsage must be an object");
  }

  const providerSource = loadProviderLoop(provider);
  const reportsCacheCreation = providerSource == null
    ? null
    : /cache_creation_input_tokens/.test(providerSource);
  const hasCacheCreation = hasOwn(streamUsage, "cache_creation_input_tokens");

  if (!hasCacheCreation && reportsCacheCreation !== false) {
    const reason = reportsCacheCreation
      ? `provider "${provider}" reports cache_creation_input_tokens but this streamUsage field is missing`
      : `provider loop for "${provider}" could not be read, so a missing cache_creation_input_tokens count is unsafe`;
    throw new Error(reason);
  }

  return {
    input: tokenCount(streamUsage.input_tokens, "input_tokens"),
    cachedInput: tokenCount(streamUsage.cache_read_input_tokens ?? 0, "cache_read_input_tokens"),
    cacheCreationInput: tokenCount(
      hasCacheCreation ? streamUsage.cache_creation_input_tokens : 0,
      "cache_creation_input_tokens",
    ),
    reasoning: tokenCount(streamUsage.thinking_tokens, "thinking_tokens"),
    output: tokenCount(streamUsage.output_tokens, "output_tokens"),
  };
}

/** Build the complete immutable run record from metadata plus emitted usage. */
export function createRunRecord({ streamUsage, ...fields }, options = {}) {
  return {
    ...fields,
    tokens: tokensFromStreamUsage(streamUsage, fields.provider, options),
  };
}

/** Read all valid rows and report every damaged row instead of skipping it. */
export function readRunLedger({ file = RUN_LEDGER_FILE, allowMissing = false } = {}) {
  let source;
  try { source = readFileSync(file, "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT" && allowMissing) return { records: [], errors: [] };
    return { records: [], errors: [`${file}: could not be read: ${error.message}`] };
  }

  const records = [];
  const errors = [];
  const seenRunIds = new Map();
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    const at = `${file}: line ${index + 1}`;
    let record;
    try { record = JSON.parse(raw); }
    catch (error) {
      errors.push(`${at}: invalid JSON: ${error.message}`);
      continue;
    }

    const validation = validateRun(record);
    if (!validation.valid) {
      errors.push(...validation.errors.map((error) => `${at}: ${error}`));
      continue;
    }
    if (!Number.isFinite(record.tokens?.cacheCreationInput) || record.tokens.cacheCreationInput < 0) {
      errors.push(`${at}: tokens.cacheCreationInput must be a non-negative number; ` +
        `the durable ledger may not confuse "not recorded" with zero`);
      continue;
    }
    if (seenRunIds.has(record.runId)) {
      errors.push(`${at}: duplicate runId "${record.runId}" (first seen on line ` +
        `${seenRunIds.get(record.runId)}) — immutable runs cannot be replayed`);
    } else {
      seenRunIds.set(record.runId, index + 1);
    }
    records.push(record);
  }

  return { records, errors };
}

/** Append one validated run. Existing run IDs are immutable. */
export function appendRunRecord(record, { file = RUN_LEDGER_FILE } = {}) {
  const validation = validateRun(record);
  if (!validation.valid) {
    throw new Error(`invalid audit run: ${validation.errors.join("; ")}`);
  }
  if (!Number.isFinite(record.tokens?.cacheCreationInput) || record.tokens.cacheCreationInput < 0) {
    throw new Error("invalid audit run: tokens.cacheCreationInput must be a non-negative number");
  }

  const current = readRunLedger({ file, allowMissing: true });
  if (current.errors.length) {
    throw new Error(`cannot append to an invalid audit ledger: ${current.errors.join("; ")}`);
  }
  if (current.records.some((existing) => existing.runId === record.runId)) {
    throw new Error(`duplicate runId "${record.runId}" — immutable audit runs cannot be overwritten or replayed`);
  }

  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
  return record;
}
