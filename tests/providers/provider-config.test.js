// T2.5 - config keys and source rules for src/providers/ (spec S2.5 §3, decision 3).
//
// - The registry drops LLAMACPP_CTX (the budget uses the served n_ctx) and adds
//   LLAMACPP_THREADS (0 = auto) and LLAMACPP_START_TIMEOUT_MS.
// - src/providers/ is exempt from the AP2 lint rule (it is where a provider may
//   be named), so this scan holds the spec's stricter line for S2.5: no
//   provider-name branch and no model-family name in code at all - quirks are
//   handled by output shape and capabilities (L-M05, AP2). No process.env (AP1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { REGISTRY } from '../../src/config/registry.js';
import { readConfig } from '../../src/config/read-config.js';

const SRC = fileURLToPath(new URL('../../src/providers/', import.meta.url));
const FILES = ['sse-stream.js', 'tool-calls.js', 'chat-provider.js', 'gguf-header.js', 'gguf-cache.js', 'llama-launcher.js'];
const entry = (key) => REGISTRY.find((e) => e.key === key);

test('LLAMACPP_CTX is gone: one context number, the served one (decision 3)', () => {
  assert.equal(entry('LLAMACPP_CTX'), undefined);
  assert.doesNotMatch(entry('LLAMACPP_SERVE_CTX').help, /LLAMACPP_CTX\b/, 'the help text no longer points at the dropped key');
});

test('LLAMACPP_THREADS: tier 1 int, default 0 = auto (performance cores - embedder threads)', () => {
  const e = entry('LLAMACPP_THREADS');
  assert.ok(e, 'LLAMACPP_THREADS is registered');
  assert.equal(e.tier, 1);
  assert.equal(e.type, 'int');
  assert.equal(e.default, '0');
  assert.match(e.help, /EMBEDDING_THREADS/);
});

test('LLAMACPP_START_TIMEOUT_MS: tier 1 int with a positive default', () => {
  const e = entry('LLAMACPP_START_TIMEOUT_MS');
  assert.ok(e, 'LLAMACPP_START_TIMEOUT_MS is registered');
  assert.equal(e.tier, 1);
  assert.equal(e.type, 'int');
  assert.ok(Number(e.default) > 0);
});

test('readConfig({}) gives the launcher every key it needs, typed', () => {
  const v = readConfig({}).values;
  for (const k of ['LLAMACPP_MODEL', 'LLAMACPP_PORT', 'LLAMACPP_SERVE_CTX', 'LLAMACPP_THREADS', 'LLAMACPP_START_TIMEOUT_MS', 'EMBEDDING_THREADS', 'LLAMA_CACHE', 'LLAMACPP_VENDOR_DIR']) {
    assert.ok(k in v, `${k} present`);
  }
  assert.equal(typeof v.LLAMACPP_THREADS, 'number');
  assert.equal(typeof v.LLAMACPP_START_TIMEOUT_MS, 'number');
});

/** Source with comments removed, so a lesson named in a comment is not a hit. */
async function code(file) {
  const text = await readFile(join(SRC, file), 'utf8');
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

test('src/providers/ holds the six spec modules', async () => {
  for (const f of FILES) await assert.doesNotReject(readFile(join(SRC, f)), `${f} exists`);
});

test('AP1: no process.env anywhere in src/providers/', async () => {
  for (const f of FILES) assert.doesNotMatch(await code(f), /process\.env/, f);
});

test('AP2: no provider-name branch and no model-family name in code', async () => {
  const providers = 'llamacpp|llama\\.cpp|ollama|anthropic|deepseek|gemini|openai|claude-code|codex';
  const branch = new RegExp(`(?:[!=]==?\\s*['"\`](?:${providers})['"\`])|(?:case\\s+['"\`](?:${providers})['"\`])|\\bprovider\\.name\\b`, 'i');
  const family = /\b(?:gemma|ornith|qwen|llava|phi-?\d|mistral)/i;
  for (const f of FILES) {
    const src = await code(f);
    assert.doesNotMatch(src, branch, `${f}: branch on a provider name`);
    assert.doesNotMatch(src, family, `${f}: a model-family name in code - key quirks by output shape or capability`);
  }
});
