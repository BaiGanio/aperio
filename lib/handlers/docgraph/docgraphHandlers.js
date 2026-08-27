// lib/handlers/docgraph/docgraphHandlers.js
// MCP / HTTP handlers for the document graph. Dispatches to the SQLite backend;
// other backends return a clean "not available" message. Mirrors the codegraph
// handler shape: safeHandler wrapping, asText success, stale-file fallback.

import { pickBackend, deleteRepo, documentExists } from '../../docgraph/indexer.js';
import { composeMemoryFromDoc, buildDocumentHighlights, clearSessionFacts } from '../../docgraph/retrieval.js';
import { aggregateDocuments } from '../../docgraph/facts/index.js';
import { bridgeTag } from '../../docgraph/memory-bridge.js';
import path from 'path';
import { logError } from '../../helpers/logger.js';

const NOT_AVAILABLE = {
  content: [{ type: "text", text: "❌ docgraph requires the Postgres or SQLite backend. Set DB_BACKEND=sqlite (zero-config) or DB_BACKEND=postgres." }],
  isError: true,
};

function asText(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function safeHandler(name, fn) {
  return async (ctx, args = {}, ...rest) => {
    try { return await fn(ctx, args, ...rest); }
    catch (err) {
      if (err.userFacing) {
        return { content: [{ type: "text", text: `❌ ${err.message}` }], isError: true };
      }
      logError(`[docgraph] ${name} failed`, err, { args });
      return { content: [{ type: "text", text: `❌ docgraph.${name} failed: ${err.message}` }], isError: true };
    }
  };
}

const backendOf = (ctx) => pickBackend(ctx.store);

// ─── Implementations ──────────────────────────────────────────────────────────
import { vectorGate, embedForStore } from "../../helpers/vecMeta.js";

async function _search(ctx, args) {
  const backend = backendOf(ctx);
  if (!backend) return NOT_AVAILABLE;
  const result = await backend.mod.search(ctx.store, args, {
    generateEmbedding: ctx.generateEmbedding,
    // Resolved to a sync predicate before the call — the backend treats
    // vectorEnabled() as a boolean, and a Promise would always read truthy.
    vectorEnabled:     await vectorGate(ctx.store, "docgraph", ctx.vectorEnabled),
  });
  return asText(result);
}

async function _repos(ctx) {
  const backend = backendOf(ctx);
  if (!backend) return NOT_AVAILABLE;
  return asText(await backend.mod.repos(ctx.store));
}

async function _manifest(ctx, args) {
  const backend = backendOf(ctx);
  if (!backend) return NOT_AVAILABLE;
  if (!args.query) { const e = new Error('query is required'); e.userFacing = true; throw e; }
  return asText(await backend.mod.manifest(ctx.store, args));
}

// `signal` is the MCP request's own AbortSignal (RequestHandlerExtra#signal),
// threaded in by the tool registration's callback — never ctx.signal. ctx is
// one shared, process-lifetime object (see mcp/index.js's createContext);
// it has no per-request fields, so ctx.signal is always undefined and every
// abort check downstream was silently dead in real tool calls.
async function _batch(ctx, args, signal, sessionId) {
  const backend = backendOf(ctx);
  if (!backend) return NOT_AVAILABLE;
  if (!Array.isArray(args.candidates)) { const e = new Error('candidates must be an array from doc_manifest'); e.userFacing = true; throw e; }

  // deferCommit:true — the session dedup cache's commit is deliberately
  // held back until just before we actually return (see below), not done
  // inside retrieveInBatches itself. Highlights/aggregation/the memory
  // bridge below all run AFTER this call returns and can themselves take a
  // while (embedding calls, DB writes); if the request is aborted/times out
  // during THAT window, the model never receives this result at all, so
  // committing the read as "already seen" here would leave a phantom dedup
  // entry for a document the conversation never actually got (llamacpp-
  // multiturn-latency.md Step 3 review, round 5, P1).
  const result = await backend.mod.batch(ctx.store, { ...args, signal, sessionId, deferCommit: true });

  // Doc_batch highlights (T-R5 model-aid #313): inject a plain-text summary
  // listing every document with a terminal-labeled amount (amount_due /
  // grand_total) so a small model can orient itself before parsing the full
  // JSON. The highlights include category hints derived from filename patterns.
  if (Array.isArray(result?.documents)) {
    try {
      result.highlights = buildDocumentHighlights(result.documents);
    } catch (hlErr) {
      logError("[docgraph] highlights generation failed", hlErr);
    }
  }

  // Deterministic aggregation (facts pipeline, issue #250): application code —
  // never the model — adds, deduplicates and totals. Computed over the
  // documents this batch actually read; skipped documents are already
  // accounted for by `coverage` and would only surface here as misleading
  // no_text exclusions. The batch records carry the extractor's per-document
  // `amounts`/`dates`, so this is a pure second pass over already-fetched
  // text with no provider calls. The optional `aggregate_period` ("YYYY-MM")
  // restricts the totals to one month; documents whose resolved period
  // differs are reported under `aggregate.excluded` rather than counted.
  if (Array.isArray(result?.documents)) {
    try {
      const read = result.documents.filter(d => d.status === "read");
      result.aggregate = aggregateDocuments(read, { period: args.aggregate_period ?? null });
    } catch (aggErr) {
      logError("[docgraph] deterministic aggregation failed", aggErr);
    }
  }

  // Docgraph → Memory bridge (#314): auto-promote high-confidence terminal
  // facts into the memory store for trend-question recall. Gated behind
  // DOCGRAPH_AUTO_MEMORY=on, off by default — deciding whether to flip that
  // default is a separate call from fixing the bridge's correctness, and is
  // tracked in the issue rather than made here.
  // NOTE: This per-batch pass processes only documents that were actually
  // returned in the current batch. A renamed or deleted document never
  // appears here, so THIS path alone would leave its promoted memory behind
  // indefinitely. That gap is covered separately: removeFile/sweepMissing/
  // deleteRepo (lib/docgraph/indexer.js) retire the corresponding bridge
  // memory at the moment a document actually leaves the index — reindex.js's
  // sweepMissing on watcher startup, live unlink/rename events, and explicit
  // repo deletion, so no reindex/delete path can end its life orphaned (#360).

  if (process.env.DOCGRAPH_AUTO_MEMORY === "on" && Array.isArray(result?.documents)) {
    for (const doc of result.documents) {
      if (!Array.isArray(doc.dates) || !Array.isArray(doc.amounts)) continue;
      if (doc.status !== "read") continue;

      // Respect request cancellation — skip remaining documents when the
      // caller has disconnected, avoiding unnecessary embedding calls and
      // database writes after the result is already discarded (#314).
      if (signal?.aborted) break;

      // Stable path — computed before composeMemoryFromDoc so it is
      // available even when the document no longer qualifies for promotion
      // (the old memory must still be retired). Converted to an opaque,
      // namespaced dedup tag so filesystem paths never reach model context
      // and bridge tags can never collide with user memories.
      const stablePath = doc.root_path && doc.rel_path
        ? `${doc.root_path}/${doc.rel_path}`
        : doc.sha256 ?? doc.rel_path ?? "unknown";
      const dedupTag = bridgeTag(stablePath);

      const memory = composeMemoryFromDoc(doc.dates, doc.amounts, {
        sha256: doc.sha256,
        title: doc.title,
        rel_path: doc.rel_path,
        root_path: doc.root_path,
      });

      try {
        // Look up the existing bridge memory by its namespaced dedup tag.
        // Ownership guard: only memories with source === "docgraph" are
        // bridge-owned. A manually created memory that happens to carry a
        // matching dag:* tag must never be mutated (#314).
        // Fetch several candidates so the source filter below still finds the
        // real bridge memory even if a user-created memory with a coincidental
        // dag:* tag ranks higher (#314).
        const candidates = await ctx.store.recall({
          tags: [dedupTag],
          limit: 5,
        });
        const bridgeOwned = candidates.filter(m => m.source === "docgraph");

        // Reconcile stale duplicates before any mutation path. If concurrent
        // doc_batch calls created more than one bridge memory for this
        // document, retire all but the first to guarantee a single current
        // copy regardless of which path is taken below (#314).
        if (bridgeOwned.length > 1) {
          for (let i = 1; i < bridgeOwned.length; i++) {
            await ctx.store.delete(bridgeOwned[i].id);
          }
        }
        const existing = bridgeOwned.slice(0, 1);

        if (signal?.aborted) break;

        if (!memory) {
          // Document no longer contains qualifying facts — retire every
          // remaining bridge-owned memory so trend recall never returns
          // stale data that was removed from its source (#314).
          for (const mem of existing) {
            await ctx.store.delete(mem.id);
          }
          continue;
        }

        // ── Check for no-op BEFORE embedding or mutation ──────────────
        // Avoids unnecessary embedding work (paid Voyage calls) and
        // prevents version churn when nothing changed (#314).
        if (existing.length) {
          const o = existing[0];
          const inputTags = [...memory.tags, "docgraph", dedupTag];
          if (o.title === memory.title && o.content === memory.content
            && JSON.stringify(o.tags) === JSON.stringify(inputTags)
            && o.importance === memory.importance
            && Number(o.tier) === 2) {
            // All content fields match, but the stored memory may lack an
            // embedding if the initial attempt failed and the retry queue
            // was lost across restart. When embeddings are enabled, requeue
            // the EXISTING memory's ID without versioning it — avoids
            // unbounded tombstone churn during an outage (#314).
            if (ctx.vectorEnabled?.() && !(await ctx.store.hasEmbedding(o.id))) {
              ctx.embeddingQueue?.enqueue(o.id, `${memory.title}. ${memory.content}`);
            }
            continue;
          }
        }

        if (signal?.aborted) break;

        // Generate the embedding. This happens AFTER the no-op check so
        // repeated reads of unchanged documents pay zero embedding cost.
        // A failed embedding (null) is handled below — the memory is
        // still written and queued for retry.
        // These land in the `memories` store, not `docgraph`, so they gate on
        // that store's status (issue #340): while it is stale/reindexing, the
        // memory is written without a vector and its reindex driver fills it.
        const { embedding, deferred } = ctx.generateEmbedding
          ? await embedForStore(ctx.store, "memories",
              () => ctx.generateEmbedding(`${memory.title}. ${memory.content}`))
          : { embedding: null, deferred: false };

        // Recheck cancellation after the (potentially slow) embedding call —
        // the caller may have disconnected during a Voyage or local-transform
        // inference, and proceeding to a DB mutation would be wasted work.
        if (signal?.aborted) break;

        // Revalidate immediately before the mutation, right after the
        // slowest step (embedding). A concurrent removeFile/sweepMissing/
        // deleteRepo can retire this exact document — and find no bridge
        // memory yet to clean up — while this call was busy generating the
        // embedding above; writing anyway would recreate the orphan #360
        // exists to prevent. Only checked when doc carries both path fields
        // (the normal case); the sha256-only fallback identity below can't
        // be looked up this way and is left to the next lifecycle sweep.
        if (doc.root_path && doc.rel_path && !(await documentExists(ctx.store, doc.root_path, doc.rel_path))) {
          for (const mem of existing) await ctx.store.delete(mem.id);
          continue;
        }

        const input = {
          type: "fact", title: memory.title, content: memory.content,
          tags: [...memory.tags, "docgraph", dedupTag],
          importance: memory.importance,
          tier: 2,
          source: "docgraph", confidence: 1.0,
        };

        if (existing.length) {
          const updated = await ctx.store.update(existing[0].id, input, embedding);
          // Enqueue for retry when embedding is unavailable, so semantic
          // recall is eventually restored (#314) — but not when the gate
          // deferred it, which is the reindex driver's row to fill (#340).
          if (!embedding && !deferred) {
            ctx.embeddingQueue?.enqueue(updated.id, `${memory.title}. ${memory.content}`);
          }

          // Same closing half as the insert branch below: update() is a
          // tombstone+insert under the hood (db/sqlite/store.js, mirrored in
          // Postgres) — it creates a brand-new row with a NEW id regardless
          // of document state. A removeFile that raced in in the meantime
          // (selecting the OLD id to retire, since the replacement didn't
          // exist yet at that lookup) would otherwise leave this new row a
          // permanent orphan (#360 review, P1). Self-heal immediately, and —
          // review round 2, P2 — BEFORE the cancellation check below: this
          // memory-integrity cleanup is not model-facing work the caller can
          // opt out of by disconnecting, so an aborted signal must never skip
          // it. Checking cancellation first would let a request that happens
          // to abort in exactly this window walk away from the very orphan
          // it just created.
          if (doc.root_path && doc.rel_path && !(await documentExists(ctx.store, doc.root_path, doc.rel_path))) {
            await ctx.store.delete(updated.id);
            continue;
          }

          if (signal?.aborted) break;
        } else {
          const created = await ctx.store.insert(input, embedding);
          if (!embedding && !deferred) {
            ctx.embeddingQueue?.enqueue(created.id, `${memory.title}. ${memory.content}`);
          }

          // Narrow closing half of the revalidation above: insert() always
          // creates a fresh row regardless of document state, so a removeFile
          // that raced between the check and this exact insert (and found
          // nothing to retire, since this row didn't exist yet) would
          // otherwise leave it permanently orphaned — no later lifecycle
          // event will ever revisit this path once the document is gone
          // (#360). Self-heal immediately rather than waiting for a purge
          // that will never come — and, same as the update branch above,
          // BEFORE the cancellation check: an abort landing right here must
          // not let this exact self-heal be skipped (review round 2, P2).
          if (doc.root_path && doc.rel_path && !(await documentExists(ctx.store, doc.root_path, doc.rel_path))) {
            await ctx.store.delete(created.id);
            continue;
          }

          if (signal?.aborted) break;

          // Post-insert dedup: a concurrent batch may have inserted a
          // duplicate between the recall above and this insert. Only
          // bridge-owned memories (source === "docgraph") are candidates
          // for cleanup — user memories are never touched (#314).
          const allWithTag = (await ctx.store.recall({
            tags: [dedupTag],
            limit: 10,
          })).filter(m => m.source === "docgraph");
          if (allWithTag.length > 1) {
            for (let i = 1; i < allWithTag.length; i++) {
              await ctx.store.delete(allWithTag[i].id);
            }
          }
        }
      } catch (err) {
        logError("[docgraph] auto-memory update failed", err, { rel_path: doc.rel_path });
      }
    }
  }

  // Shrink dedup'd documents to their short pointer LAST, only in the
  // model-facing payload — highlights, aggregation, and the memory bridge
  // above have already consumed the REAL cached text retrieveInBatches
  // returned for a dedup hit (see lib/docgraph/retrieval.js), so a repeat
  // read still contributes correctly to deterministic totals/classification
  // instead of looking like a document with no recognizable content.
  if (Array.isArray(result?.documents)) {
    result.documents = result.documents.map(doc => {
      if (!doc.dedup) return doc;
      const { dedupPointerText, ...rest } = doc;
      return { ...rest, text: dedupPointerText };
    });
  }

  // Commit the session dedup cache now, at the last possible moment before
  // the result is actually handed back — everything that could plausibly
  // take a while (highlights, aggregation, the memory-bridge's embedding/DB
  // calls) has already finished. If the request was aborted/cancelled
  // anywhere along the way, skip the commit entirely: the model never
  // received this text, so recording it as "already read" would silently
  // withhold it on a retry (round 5, P1). `commitSessionFacts` is only
  // present when a sessionId was actually supplied (see retrieveInBatches).
  // NOTE: this commits inside the MCP child process, unconditional on the
  // eventual DELIVERED size of `result` — the main agent process's tool-
  // result offloader (lib/context/toolResultOffload.js, wired through
  // createToolResultOffloadMiddleware in lib/agent/model-context-middleware.js)
  // may still shrink this JSON to a head/tail preview if it is large, AFTER
  // this commit has already happened and this call has already returned. That
  // middleware is responsible for invalidating this same session's dedup
  // cache when it offloads (round 14, P1) — if you are changing either side
  // of that contract, keep both in sync.
  if (!signal?.aborted) result.commitSessionFacts?.();
  delete result.commitSessionFacts;

  return asText(result);
}

async function _outline(ctx, args) {
  const backend = backendOf(ctx);
  if (!backend) return NOT_AVAILABLE;
  const result = await backend.mod.outline(ctx.store, args);
  if (!result) return { content: [{ type: "text", text: `No indexed document matches path='${args.path}'` }], isError: true };
  return asText(result);
}

async function _context(ctx, { path: docPath, section_id, chunk_id, folder }) {
  const backend = backendOf(ctx);
  if (!backend) return NOT_AVAILABLE;
  const ref = await backend.mod.context(ctx.store, { path: docPath, section_id, chunk_id, folder });
  if (!ref) {
    const key = chunk_id != null ? `chunk_id=${chunk_id}` : `section_id=${section_id}`;
    return { content: [{ type: "text", text: `No match for path='${docPath}' ${key}` }], isError: true };
  }
  return asText({
    path: ref.rel_path, repo: path.basename(ref.root_path), root_path: ref.root_path,
    heading: ref.heading, text: ref.text,
  });
}

async function _refs(ctx, args) {
  const backend = backendOf(ctx);
  if (!backend) return NOT_AVAILABLE;
  if (!args.ref) { const e = new Error('ref is required'); e.userFacing = true; throw e; }
  return asText(await backend.mod.refs(ctx.store, args));
}

async function _deleteRepo(ctx, { path: rootPath }) {
  const backend = backendOf(ctx);
  if (!backend) return NOT_AVAILABLE;
  if (!rootPath) { const e = new Error('path is required'); e.userFacing = true; throw e; }
  return asText(await deleteRepo(ctx.store, rootPath));
}

// Internal-only, never model-facing (see the tool registration comment in
// mcp/tools/docgraph.js): releases one session's doc_batch dedup cache
// (lib/docgraph/retrieval.js's sessionReadFacts), which lives ONLY inside
// this MCP child process — a doc_batch/retrieveInBatches call never runs
// anywhere else. The main server process cannot clear it directly; it must
// go through a real MCP round trip like this one (llamacpp-multiturn-
// latency.md Step 3 review, round 3, P1: an earlier fix that called
// clearSessionFacts() from the main process's own copy of retrieval.js was a
// no-op — a completely separate module instance in a completely separate
// OS process).
async function _clearSessionCache(ctx, { sessionId } = {}) {
  if (sessionId) clearSessionFacts(sessionId);
  return asText({ ok: true });
}

// ─── Public exports ───────────────────────────────────────────────────────────
export const searchHandler     = safeHandler('search',     _search);
export const reposHandler      = safeHandler('repos',      _repos);
export const manifestHandler   = safeHandler('manifest',   _manifest);
export const batchHandler      = safeHandler('batch',      _batch);
export const outlineHandler    = safeHandler('outline',    _outline);
export const contextHandler    = safeHandler('context',    _context);
export const refsHandler       = safeHandler('refs',       _refs);
export const deleteRepoHandler = safeHandler('deleteRepo', _deleteRepo);
export const clearSessionCacheHandler = safeHandler('clearSessionCache', _clearSessionCache);
