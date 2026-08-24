#!/usr/bin/env node
//
// scripts/check-sri.js — verify every Subresource Integrity pin in public/*.html
//
// Three pages load CDN assets with hand-written SRI hashes (#466). A version
// bump that forgets to update the hash fails *silently*: the browser drops the
// asset, so icons vanish or a Mermaid diagram never renders, with no error the
// user reads. The bootstrap-icons hash is duplicated across three files, so a
// bump can also update two of three and leave the third dead.
//
// This script parses every element carrying an `integrity` attribute, fetches
// the bytes, recomputes the digest for the declared algorithm, and compares.
// It also asserts that one URL never carries two different hashes.
//
// Failure policy — "could not fetch" is NOT "the hash is wrong":
//   mismatch / missing (HTTP 4xx) / bad algorithm / cross-file conflict
//        → exit 1. Something in the repo is wrong and a human must fix it.
//   network error, timeout, HTTP 5xx (after retries)
//        → exit 0 with a loud UNVERIFIED warning. A jsDelivr outage must never
//          redden a build and block an unrelated PR.
//
// The fetch lives behind an injectable seam (`fetchImpl`) so the unit suite in
// tests/unit/security/sri-check.test.js never touches the network.

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = join(ROOT, "public");

const SUPPORTED_ALGORITHMS = new Set(["sha256", "sha384", "sha512"]);

const DEFAULTS = { retries: 2, retryDelayMs: 1000, timeoutMs: 20000, concurrency: 4 };

// ── Parsing ──────────────────────────────────────────────────────────────────

// Any tag that carries an integrity attribute. Deliberately dumb: these are
// hand-written head elements, not arbitrary markup, and a real HTML parser
// would be a dependency for four <link>/<script> tags.
const TAG_RE = /<(link|script)\b[^>]*\bintegrity\s*=\s*("[^"]*"|'[^']*')[^>]*>/gis;

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  return m ? (m[2] ?? m[3]) : null;
}

/** Split an integrity attribute into its `algorithm-base64digest` tokens. */
function parseIntegrity(value) {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      const dash = token.indexOf("-");
      if (dash === -1) return { algorithm: token, digest: "", malformed: true };
      return { algorithm: token.slice(0, dash).toLowerCase(), digest: token.slice(dash + 1) };
    });
}

/**
 * Every integrity-bearing reference in one document.
 * @returns {Array<{source:string,line:number,url:string,integrity:string,hashes:Array}>}
 */
export function parseIntegrityRefs(html, source) {
  const refs = [];
  for (const match of html.matchAll(TAG_RE)) {
    const tag = match[0];
    const url = attr(tag, "href") ?? attr(tag, "src");
    const integrity = attr(tag, "integrity");
    if (!url || !integrity) continue;
    refs.push({
      source,
      line: html.slice(0, match.index).split("\n").length,
      url,
      integrity,
      hashes: parseIntegrity(integrity),
    });
  }
  return refs;
}

// ── Cross-file consistency ───────────────────────────────────────────────────

/**
 * One URL must carry one integrity value everywhere it appears. Catches the
 * half-finished bump: two pages updated, the third left on the old hash.
 */
export function findHashConflicts(refs) {
  const byUrl = new Map();
  for (const ref of refs) {
    if (!byUrl.has(ref.url)) byUrl.set(ref.url, new Map());
    const variants = byUrl.get(ref.url);
    const key = ref.integrity.trim().replace(/\s+/g, " ");
    if (!variants.has(key)) variants.set(key, []);
    variants.get(key).push(`${ref.source}:${ref.line}`);
  }

  const conflicts = [];
  for (const [url, variants] of byUrl) {
    if (variants.size < 2) continue;
    conflicts.push({
      url,
      variants: [...variants].map(([integrity, sources]) => ({ integrity, sources })),
    });
  }
  return conflicts;
}

// ── Verification ─────────────────────────────────────────────────────────────

const isRemote = (url) => /^https?:\/\//i.test(url);

async function readBytes(ref, opts) {
  if (!isRemote(ref.url)) {
    if (/^\/\//.test(ref.url)) return { kind: "unreachable", detail: "protocol-relative URL" };
    const root = opts.localRoot ?? PUBLIC_DIR;
    const rel = ref.url.replace(/^\//, "").split(/[?#]/)[0];
    try {
      return { kind: "bytes", bytes: await readFile(join(root, rel)) };
    } catch (err) {
      return { kind: "missing", detail: `no such local file: ${rel} (${err.code ?? err.message})` };
    }
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const retries = opts.retries ?? DEFAULTS.retries;
  let last = "";
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(opts.retryDelayMs ?? DEFAULTS.retryDelayMs);
    try {
      const res = await fetchImpl(ref.url, {
        redirect: "follow",
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULTS.timeoutMs),
      });
      if (res.ok) return { kind: "bytes", bytes: Buffer.from(await res.arrayBuffer()) };
      // 4xx is the repo's problem (the pinned version is gone); 5xx is theirs.
      if (res.status >= 400 && res.status < 500) {
        return { kind: "missing", detail: `HTTP ${res.status}` };
      }
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err?.message ?? String(err);
    }
  }
  return { kind: "unreachable", detail: last };
}

/** Verify one reference. Never throws — every outcome is a status. */
export async function verifyRef(ref, opts = {}) {
  const where = `${ref.source}:${ref.line}`;

  const bad = ref.hashes.find((h) => h.malformed || !SUPPORTED_ALGORITHMS.has(h.algorithm));
  if (bad) {
    return {
      ref,
      status: "unsupported-algorithm",
      detail: `${where} — ${bad.malformed ? "malformed integrity token" : `unsupported algorithm "${bad.algorithm}"`}: ${ref.integrity}`,
    };
  }

  const read = await readBytes(ref, opts);
  if (read.kind !== "bytes") {
    return { ref, status: read.kind, detail: `${where} — ${read.detail}` };
  }

  // SRI passes if ANY declared hash matches the bytes.
  for (const h of ref.hashes) {
    const digest = createHash(h.algorithm).update(read.bytes).digest("base64");
    if (digest === h.digest) return { ref, status: "ok", bytes: read.bytes.length };
  }

  const primary = ref.hashes[0];
  const actual = `${primary.algorithm}-${createHash(primary.algorithm).update(read.bytes).digest("base64")}`;
  return {
    ref,
    status: "mismatch",
    actual,
    detail: `${where} — declared ${ref.integrity}, the ${read.bytes.length} fetched bytes hash to ${actual}`,
  };
}

/** Verify many references, a few at a time so a page of pins is not serial. */
export async function verifyRefs(refs, opts = {}) {
  const limit = Math.max(1, opts.concurrency ?? DEFAULTS.concurrency);
  const results = new Array(refs.length);
  let next = 0;
  const worker = async () => {
    while (next < refs.length) {
      const i = next++;
      results[i] = await verifyRef(refs[i], opts);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, refs.length) }, worker));
  return results;
}

// ── Summary ──────────────────────────────────────────────────────────────────

const HARD_FAILURES = new Set(["mismatch", "missing", "unsupported-algorithm"]);

export function summarize(results, conflicts) {
  const failures = results.filter((r) => HARD_FAILURES.has(r.status));
  const unverified = results.filter((r) => r.status === "unreachable");
  return {
    results,
    conflicts,
    ok: results.filter((r) => r.status === "ok").length,
    failed: failures.length,
    unverified: unverified.length,
    failures,
    unreachable: unverified,
    exitCode: failures.length > 0 || conflicts.length > 0 ? 1 : 0,
  };
}

// ── Orchestration ────────────────────────────────────────────────────────────

async function collectRefs(dir) {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".html")).sort();
  const refs = [];
  for (const file of files) {
    refs.push(...parseIntegrityRefs(await readFile(join(dir, file), "utf8"), file));
  }
  return refs;
}

/**
 * Parse a directory of pages, check cross-file agreement, verify the bytes.
 * `parseOnly: true` stops before any fetch — used by the unit suite to keep
 * `npm test` off the network.
 */
export async function checkSri(opts = {}) {
  const dir = opts.dir ?? PUBLIC_DIR;
  const refs = await collectRefs(dir);
  const conflicts = findHashConflicts(refs);
  if (opts.parseOnly) return { refs, conflicts, results: [], exitCode: conflicts.length ? 1 : 0 };
  const results = await verifyRefs(refs, { localRoot: dir, ...opts });
  return { refs, ...summarize(results, conflicts) };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

// GitHub Actions renders these as annotations; elsewhere they are plain lines.
const annotate = (level, message) =>
  process.env.GITHUB_ACTIONS === "true"
    ? `::${level}::${message.replace(/\n/g, "%0A")}`
    : `${level.toUpperCase()}: ${message}`;

function report(summary) {
  for (const r of summary.results) {
    if (r.status === "ok") console.log(`  ok        ${r.ref.source}:${r.ref.line}  ${r.ref.url}`);
  }
  for (const c of summary.conflicts) {
    const detail = c.variants.map((v) => `    ${v.integrity}\n      ${v.sources.join(", ")}`).join("\n");
    console.error(annotate("error", `${c.url} is pinned to ${c.variants.length} different hashes:\n${detail}`));
  }
  for (const r of summary.failures) {
    console.error(annotate("error", `SRI ${r.status}: ${r.detail}`));
  }
  for (const r of summary.unreachable) {
    console.error(annotate("warning", `SRI UNVERIFIED (could not fetch, not a hash failure): ${r.detail}`));
  }

  console.log(
    `\n${summary.ok} verified, ${summary.failed} failed, ${summary.unverified} unverified, ` +
      `${summary.conflicts.length} cross-file conflict(s).`,
  );
  if (summary.exitCode === 0 && summary.unverified > 0) {
    console.log("Exiting 0: an unreachable CDN is an outage, not a broken pin.");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const summary = await checkSri();
  report(summary);
  process.exit(summary.exitCode);
}
