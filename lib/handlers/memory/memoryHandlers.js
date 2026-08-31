import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, readdirSync, statSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redact } from "../../privacy/redact.js";
import logger from "../../helpers/logger.js";
import { localeToPgConfig } from "../../../db/postgres.js";
import { isVectorSearchable, embedForStore } from "../../helpers/vecMeta.js";
// mcp/handlers/memoryHandlers.js
// Pure async handler functions for all memory-related MCP tools.
//
// Each function accepts a "ctx" object as its first argument — containing
// the dependencies it needs (store, generateEmbedding, vectorEnabled) —
// followed by the tool's own input arguments.
//
// This makes every handler independently importable and testable without
// booting the MCP server or touching a real database.

// ── Privacy Shield redact-mode side channel (issue #531 review round 2) ────
//
// recallHandler's redaction map must NEVER travel in the public CallToolResult:
// a standalone cloud-backed MCP client (Claude Desktop, Cursor, or anything
// else talking to this server directly — see createContext()'s
// providerIsLocal comment) receives that result verbatim, including
// structuredContent, which would hand it every original email/phone/card/IBAN
// the visible text deliberately redacted. Instead recallHandler stores the map
// server-side, keyed by a random single-use correlation id, and returns only
// that opaque id in the public result. Only our own agent process knows to
// exchange it — via the "aperio/takeRedactionMap" custom protocol method
// registered in mcp/index.js, outside the Tools capability entirely and so
// invisible to tools/list() (same reasoning as clearDocSessionCache) — and
// takeRedactionMap() below deletes the entry the moment it is read, so a
// leaked/replayed id is worthless a second time.
//
// Abandoned entries (a standalone client that ignores the id, or the agent
// process crashing/erroring before it ever redeems one) must not just sit on
// real PII forever — this is the sensitive-data-lifecycle case AGENTS.md
// calls out directly. Every entry is swept the moment it's older than its
// TTL: proactively by the writer's own timer (review round 3, P2) AND
// opportunistically by every reader/writer touching the directory
// afterwards (sweepExpiredRedactionMaps() below) — so a file survives even a
// hard process kill only until the next unrelated recall call anywhere, not
// forever.
//
// 20 minutes, not a short number: this must outlive the whole provider turn,
// not just the recall call — reasoning/tool work after recall returns can run
// long, and the on-demand redemption path (redaction-relay.js) only reads the
// map once the model's final answer streams. Matches CODEX_TURN_TIMEOUT_MS
// (lib/config.js), the documented ceiling on how long one turn may run —
// there is no reason for this entry to expire before that turn could.
const REDACTION_MAP_TTL_MS = 20 * 60_000;

// Codex runs recall inside its OWN mcp/index.js child process — spawned
// directly by the `codex` CLI (lib/agent/providers/codex.js's
// buildCodexArgs) — a different OS process from the one lib/agent/
// mcp-connect.js spawns for every other provider's tool calls and for
// takeRedactionMap() itself. An in-memory Map is invisible across that
// boundary: a map written by Codex's process could never be read by
// takeRedactionMap() running in the app's own process (review round 4, P1).
//
// Both spawn sites now forward APERIO_RUNTIME_ROOT (lib/agent/mcp-connect.js,
// lib/agent/providers/codex.js) — the same configured mutable-runtime-state
// directory lib/server.js resolves as RUNTIME_ROOT, which need not be the
// code checkout (a separate writable runtimeRoot, or a read-only source
// install). Writing under the checkout unconditionally could fail with
// EACCES there, or leave PII outside the configured runtime-state boundary
// (review round 6, P2). Falling back to a path derived from THIS FILE's own
// location — never cwd — preserves the old behavior for anything that
// doesn't set the env var: a standalone `npm run mcp` deployment with no
// spawner to set it, or a test that imports this module directly.
const REDACTION_MAP_DIR = join(
  process.env.APERIO_RUNTIME_ROOT
    ? resolve(process.env.APERIO_RUNTIME_ROOT)
    : resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
  "var", "redaction-maps",
);
const CORRELATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function redactionMapPath(correlationId) {
  return join(REDACTION_MAP_DIR, `${correlationId}.json`);
}

/** Best-effort: deletes any entry older than the TTL, regardless of which
 *  process (or which now-dead process) wrote it. Safe to call from either
 *  process at any time — a raced unlink against another sweeper or a
 *  redeeming reader just throws ENOENT, which is exactly "already gone".
 *
 *  Exported so a long-lived process can run this on a timer (review round 5,
 *  P1): the writer's own setTimeout below is not enough on its own — Codex
 *  runs recall inside its own short-lived, unref'd MCP child (see the
 *  REDACTION_MAP_DIR comment above), which can exit well before its 20-minute
 *  callback ever fires, orphaning that timer along with it. This directory is
 *  shared by file path, not by process, so any long-lived owner sweeping it
 *  periodically — lib/workers/redaction-map-prune.js, wired into the main
 *  server's background workers — cleans up entries no writer process
 *  survived long enough to expire itself. */
export function sweepExpiredRedactionMaps() {
  let names;
  try { names = readdirSync(REDACTION_MAP_DIR); } catch { return 0; }
  const cutoff = Date.now() - REDACTION_MAP_TTL_MS;
  let removed = 0;
  for (const name of names) {
    const path = join(REDACTION_MAP_DIR, name);
    try {
      if (statSync(path).mtimeMs < cutoff) { unlinkSync(path); removed++; }
    } catch { /* raced — already gone */ }
  }
  return removed;
}

function writeRedactionMap(correlationId, redactionMap) {
  sweepExpiredRedactionMaps();
  // Owner-only: these files hold restored PII (email/phone/card/IBAN). On a
  // typical 022 umask, mkdir/writeFile default modes (0755/0644) let any
  // other local user list and read them (review round 5, P2). Neither mode
  // below has group/other bits set, so no umask can add them back.
  mkdirSync(REDACTION_MAP_DIR, { recursive: true, mode: 0o700 });
  try { chmodSync(REDACTION_MAP_DIR, 0o700); } catch { /* best-effort for a pre-existing dir */ }
  writeFileSync(redactionMapPath(correlationId), JSON.stringify(Object.fromEntries(redactionMap)), { encoding: "utf-8", mode: 0o600 });
  const timer = setTimeout(() => {
    try { unlinkSync(redactionMapPath(correlationId)); } catch { /* already redeemed */ }
  }, REDACTION_MAP_TTL_MS);
  timer.unref?.();
}

/** Single-use read: returns the map (as a plain object) and deletes it, or
 *  null if the id is unknown/expired/already consumed/malformed. Works
 *  regardless of which process's recallHandler wrote the entry. */
export function takeRedactionMap(correlationId) {
  if (typeof correlationId !== "string" || !CORRELATION_ID_RE.test(correlationId)) return null;
  const path = redactionMapPath(correlationId);
  try {
    const raw = readFileSync(path, "utf-8");
    unlinkSync(path);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function rememberHandler(ctx, { type, title, content, tags, importance, tier, expires_at, lang, confidence, source: sourceOverride }) {
  const { store, generateEmbedding } = ctx;

  // Gated: while this store is stale/reindexing — or `current` toward another
  // process's embedding configuration — the row is written without a vector
  // and the reindex driver fills it in later (issue #340).
  const { embedding, deferred } = await embedForStore(store, "memories",
    () => generateEmbedding(`${title}. ${content}`));
  const source = sourceOverride
    || (process.env.AI_PROVIDER === "llamacpp"
      ? (process.env.LLAMACPP_MODEL  || "llamacpp")
      : (process.env.ANTHROPIC_MODEL || "claude"));

  // Reject TTLs in the past or within the next hour — models sometimes send
  // today's date or a specific time that has already passed.
  let validExpiry = undefined;
  if (expires_at) {
    const expiryDate = new Date(expires_at);
    if (!Number.isNaN(expiryDate.getTime()) && expiryDate > new Date(Date.now() + 3600_000)) {
      validExpiry = expiryDate;
    } else {
      logger.warn(`[remember] ignoring expires_at "${expires_at}" — date is in the past or < 1h from now`);
    }
  }

  // Resolve tier: explicit value wins; the legacy local-only tag maps to tier 2.
  let resolvedTier = tier ?? 1;
  if (resolvedTier === 1 && (tags ?? []).some(t => String(t).toLowerCase() === "local-only")) {
    resolvedTier = 2;
  }

  const mem = await store.insert(
    { type: type ?? "fact", title, content, tags: tags ?? [], importance: importance ?? 3,
      tier: resolvedTier,
      expires_at: validExpiry, source,
      lang: localeToPgConfig(lang), confidence: confidence ?? 1.0 },
    embedding
  );

  if (deferred) {
    logger.info(`[remember] id=${mem.id} saved without an embedding — the memories store is being reindexed; its reindex driver will embed this row.`);
  } else if (!embedding) {
    logger.warn(`⚠️  Embedding unavailable for memory id=${mem.id} — queued for retry`);
    ctx.embeddingQueue?.enqueue(mem.id, `${title}. ${content}`);
  }
  const embeddingNote = embedding
    ? " (with semantic embedding)"
    : deferred
      ? " (no embedding yet — memory embeddings are being reindexed; semantic search returns to this row when that finishes)"
      : " (no embedding — semantic search unavailable until backfill)";
  return {
    content: [{ type: "text", text: `✅ Memory saved [${mem.type}] "${mem.title}"${embeddingNote} (id: ${mem.id})` }],
  };
}

export async function recallHandler(ctx, { query, type, tags, limit: _limit, maxTier, search_mode = "auto", lang, as_of, order = "importance" }) {
  const { store, generateEmbedding, vectorEnabled } = ctx;

  const limit = _limit !== undefined ? Number.parseInt(_limit, 10) : 10;
  const resolvedMaxTier = maxTier ?? 3;

  // A stale/reindexing memories store holds vectors from a previous embedding
  // configuration; scoring a fresh query against them mixes vector spaces.
  // Skipping the query embedding degrades recall to full-text (issue #287).
  const vectorOk = vectorEnabled() && await isVectorSearchable(store, "memories");
  // Downgrade the *mode*, not just the embedding. Both backends compute
  // useText as `mode !== "semantic"`, so leaving an explicit search_mode of
  // "semantic" in place while withholding the embedding disables vector search
  // AND full-text search — the query then degenerates into an unfiltered
  // importance listing that returns unrelated memories.
  const effectiveMode = vectorOk ? search_mode : "fulltext";
  const queryEmbedding = (query && vectorOk && effectiveMode !== "fulltext")
    ? await generateEmbedding(query, "query")
    : null;

  const rawRows = await store.recall({ query, queryEmbedding, type, tags, limit, mode: effectiveMode, lang: localeToPgConfig(lang), asOf: as_of, order, maxTier: resolvedMaxTier });

  // Privacy gate: on a cloud provider, never surface private or sensitive
  // memories. Tier 3 (private) is always dropped — it never leaves the machine.
  // Tier 2 (sensitive): APERIO_CLOUD_SENSITIVE_MODE controls behavior —
  //   "withhold" (default): filtered out entirely (like tier 3)
  //   "redact":           PII-scrubbed via redact() before sending
  // Local (llama.cpp) sessions see everything within maxTier.
  const sensitiveMode = process.env.APERIO_CLOUD_SENSITIVE_MODE || "withhold";
  // Accumulates every row's placeholder → original mapping so the caller can
  // restore() the model's reply before it reaches the user (issue #531).
  // redact() restarts its placeholder counter at 0 per call, so two rows both
  // containing e.g. an email would each mint «EMAIL_0» — prefixing by row
  // index keeps tokens unique WITHIN this call. That alone isn't enough: the
  // model can call recall more than once in the same turn, and each
  // invocation of this function restarts at row 0 too, so two DIFFERENT
  // calls could still both mint «0_EMAIL_0» and collide when the agent loop
  // merges them into one turn-wide map (review round 2, P2). correlationId
  // is generated fresh per call and namespaces every token this call mints,
  // so no two recall calls — in this turn or any other — can ever produce
  // the same token. It doubles as the lookup key for the private
  // take-redaction-map side channel below.
  let correlationId = null;
  const redactionMap = new Map();
  const rows = ctx.providerIsLocal === false
    ? rawRows.filter(m => {
        const t = m.tier ?? 1;
        if (t >= 3) return false;                        // tier 3: never leaves
        if (t === 2 && sensitiveMode !== "redact") return false; // tier 2: withheld or kept
        return true;                                      // tier 1: always passes
      }).map((m, idx) => {
        if ((m.tier ?? 1) >= 2 && sensitiveMode === "redact") {
          if (!correlationId) correlationId = randomUUID();
          const { text, map } = redact(m.content);
          let content = text;
          for (const [token, original] of map) {
            const uniqueToken = `«${correlationId}_${idx}_${token.slice(1)}`;
            content = content.split(token).join(uniqueToken);
            redactionMap.set(uniqueToken, original);
          }
          return { ...m, content };
        }
        return m;
      })
    : rawRows;

  if (!rows.length)
    return { content: [{ type: "text", text: "No memories found." }] };

  const formatted = rows.map(m => {
    const simNote  = m.similarity  !== undefined ? ` [similarity: ${(m.similarity * 100).toFixed(1)}%]` : "";
    const confNote = m.confidence  !== undefined && m.confidence < 1.0
      ? ` [confidence: ${(m.confidence * 100).toFixed(0)}%]` : "";
    return `[${m.type.toUpperCase()}] ${m.title}${simNote}${confNote} (importance: ${m.importance})\n${m.content}\nTags: ${(m.tags||[]).join(", ")||"none"}\nID: ${m.id}`;
  }).join("\n---\n");

  // No-query recall lists the top-N by importance. When more memories exist than
  // were returned, make the truncation explicit so the model never mistakes this
  // listing for the user's entire memory and denies having more. (Footer carries
  // no "---" separator, so it stays attached to the last block and never parses
  // as a phantom memory.)
  let footer = "";
  if (!query) {
    try {
      const { current } = await store.counts();
      if (current > rows.length) {
        footer = `\n\n— Preview only: showing the ${rows.length} highest-priority of ${current} stored memories. Call recall with a query to search the rest.`;
      }
    } catch { /* count is best-effort — omit footer on failure */ }
  }

  if (redactionMap.size) {
    writeRedactionMap(correlationId, redactionMap);
  }

  return {
    content: [{ type: "text", text: formatted + footer }],
    // Only an opaque, non-sensitive lookup key crosses the public MCP
    // result — never the map itself. A standalone cloud-backed MCP client
    // (Claude Desktop, Cursor, …) sees this id and nothing else; only our
    // own agent knows to redeem it via "aperio/takeRedactionMap"
    // (mcp/index.js), a custom protocol method outside the Tools capability
    // and so invisible to tools/list(). See takeRedactionMap() above.
    ...(redactionMap.size ? { structuredContent: { redactionCorrelationId: correlationId } } : {}),
  };
}

export async function updateMemoryHandler(ctx, { id, title, content, tags, importance }) {
  const { store, generateEmbedding, vectorEnabled } = ctx;

  const input = {};
  if (title      !== undefined) input.title      = title;
  if (content    !== undefined) input.content    = content;
  if (tags       !== undefined) input.tags       = tags;
  if (importance !== undefined) input.importance = importance;
  if (!Object.keys(input).length)
    return { content: [{ type: "text", text: "❌ No fields to update." }] };

  // Capture the fallback text for embedding — read current state just-in-time,
  // then capture the merged text before the async generateEmbedding() call
  // so the reference is frozen and cannot become stale. The authoritative
  // read+validate happens inside store.update() (both backends re-read
  // with synchronization inside a transaction or synchronous block).
  let embedText = '';
  let embedding;
  let deferred = false;
  if ((title || content) && vectorEnabled()) {
    const current = await store.getById(id);
    if (!current) return { content: [{ type: "text", text: `❌ No memory found: ${id}` }] };
    if (current.valid_until) return { content: [{ type: "text", text: `❌ Memory ${id} has been superseded — use its replacement ID instead.` }] };
    embedText = `${title ?? current.title}. ${content ?? current.content}`;
    ({ embedding, deferred } = await embedForStore(store, "memories",
      () => generateEmbedding(embedText)));
  }

  try {
    const updated = await store.update(id, input, embedding);
    // An update versions the row, so the new row starts without a vector. When
    // the gate refused (issue #340) that is deliberate and the store's reindex
    // driver owns the backfill — queueing here would only re-race the gate.
    if ((title || content) && !embedding && !deferred) {
      ctx.embeddingQueue?.enqueue(updated.id, `${updated.title}. ${updated.content}`);
    }
    return { content: [{ type: "text", text: `✅ Updated: "${updated.title}" (new id: ${updated.id})` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `❌ ${err.message}` }] };
  }
}

export async function forgetHandler(ctx, { id }) {
  const { store } = ctx;

  const title = await store.delete(id);
  if (!title) return { content: [{ type: "text", text: `❌ No memory found: ${id}` }] };
  return { content: [{ type: "text", text: `🗑️ Forgotten: "${title}"` }] };
}

export async function backfillHandler(ctx, { limit = 20 }) {
  const { store, generateEmbedding, vectorEnabled } = ctx;

  if (!vectorEnabled()) return { content: [{ type: "text", text: "❌ Vector search not enabled." }] };

  // A manual backfill while the store is stale/reindexing is duplicate work at
  // best and a foreign-space write at worst (issue #340) — the reindex driver
  // is already walking this exact pending scan under the signature that owns
  // the store. Refuse up front rather than embed rows that get discarded.
  if (!await isVectorSearchable(store, "memories"))
    return { content: [{ type: "text", text: "❌ Memory embeddings are being reindexed after an embedding-configuration change — that backfill belongs to the reindex driver (npm run embeddings:reindex)." }] };

  const pending = (await store.listWithoutEmbeddings()).slice(0, limit);
  if (!pending.length)
    return { content: [{ type: "text", text: "✅ All memories already have embeddings!" }] };

  let success = 0, failed = 0, stopped = false;
  for (const row of pending) {
    // Re-gated per row: a reindex can start partway through a long backfill,
    // and every row after that point would otherwise land in the wrong space.
    const { embedding, deferred } = await embedForStore(store, "memories",
      () => generateEmbedding(`${row.title}. ${row.content}`));
    if (deferred) { stopped = true; break; }
    if (embedding) { await store.setEmbedding(row.id, embedding); success++; }
    else failed++;
  }

  const note = stopped
    ? " Stopped early — a reindex claimed this store; the rest is its to finish."
    : "";
  return {
    content: [{ type: "text", text: `✅ Backfill complete: ${success} embedded, ${failed} failed. ${pending.length - success - failed} remaining.${note}` }],
  };
}

export async function dedupHandler(ctx, { threshold = 0.97, dry_run = true }) {
  const { store, vectorEnabled } = ctx;

  if (!vectorEnabled())
    return { content: [{ type: "text", text: "❌ Vector search not enabled — dedup requires embeddings." }] };

  // Similarity across two embedding spaces is meaningless, so a store that is
  // not fully reindexed would yield nonsense "duplicate" pairs — and dedup
  // merges rows, so acting on them destroys data (issue #287).
  if (!await isVectorSearchable(store, "memories"))
    return { content: [{ type: "text", text: "❌ Memory embeddings are being reindexed after an embedding-configuration change — dedup is unavailable until that finishes (npm run embeddings:reindex)." }] };

  const pairs = await store.findDuplicates(threshold);
  if (!pairs.length)
    return { content: [{ type: "text", text: `✅ No duplicates found above ${(threshold * 100).toFixed(0)}% similarity.` }] };

  let report = `Found ${pairs.length} near-duplicate pair(s):\n\n`;
  let merged = 0;

  for (const row of pairs) {
    report += `[${(row.similarity * 100).toFixed(1)}% similar]\n`;
    report += `  A: [${row.type_a}] "${row.title_a}" (${row.id_a})\n`;
    report += `  B: [${row.type_b}] "${row.title_b}" (${row.id_b})\n\n`;
    if (!dry_run) { await store.mergeDuplicate(row.id_a, row.id_b); merged++; }
  }

  report += dry_run
    ? `Run with dry_run=false to merge these automatically.`
    : `\n🧹 Merged ${merged} duplicate(s).`;

  return { content: [{ type: "text", text: report }] };
}

// ── Memory inbox (propose → user reviews → approve/reject) ──────────────────
export async function proposeMemoryHandler(ctx, { type, title, content, tags, importance, tier, confidence, lang }) {
  const { store } = ctx;
  const source = process.env.AI_PROVIDER === "llamacpp"
    ? (process.env.LLAMACPP_MODEL || "llamacpp")
    : (process.env.ANTHROPIC_MODEL || "claude");

  const pending = await store.insertPending({
    type: type ?? "fact", title, content,
    tags: tags ?? [], importance: importance ?? 3,
    tier: tier ?? 1, source, lang, confidence: confidence ?? 1.0
  });

  return {
    content: [{
      type: "text",
      text: `📥 Memory proposed for review: "${pending.title}" [${pending.type}] (id: ${pending.id})\nThe user will review it before it enters the memory store.`
    }]
  };
}