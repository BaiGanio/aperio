// lib/handlers/docgraph/docgraphHandlers.js
// MCP / HTTP handlers for the document graph. Dispatches to the SQLite backend;
// other backends return a clean "not available" message. Mirrors the codegraph
// handler shape: safeHandler wrapping, asText success, stale-file fallback.

import { createHash } from 'node:crypto';
import { pickBackend, deleteRepo } from '../../docgraph/indexer.js';
import { composeMemoryFromDoc, buildDocumentHighlights } from '../../docgraph/retrieval.js';
import path from 'path';
import { logError } from '../../helpers/logger.js';

// Deterministic, opaque dedup tag for a document path. Combines a short
// namespace prefix ("dag:") with a SHA-256 hash truncated to 64 bits so
// the tag never contains a filesystem path and never collides with user
// tags. The namespace avoids false matches against user memories that
// happen to contain the same hex string.
function bridgeTag(stablePath) {
  const hash = createHash('sha256').update(stablePath).digest('hex');
  return 'dag:' + hash.slice(0, 16);
}

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
import { vectorGate } from "../../helpers/vecMeta.js";

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
async function _batch(ctx, args, signal) {
  const backend = backendOf(ctx);
  if (!backend) return NOT_AVAILABLE;
  if (!Array.isArray(args.candidates)) { const e = new Error('candidates must be an array from doc_manifest'); e.userFacing = true; throw e; }

  const result = await backend.mod.batch(ctx.store, { ...args, signal });

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

  // Docgraph → Memory bridge (#314): auto-promote high-confidence terminal
  // facts into the memory store for trend-question recall. Gated behind
  // DOCGRAPH_AUTO_MEMORY=on (off by default until #287 lands).
  // NOTE: This per-batch pass processes only documents that were actually
  // returned in the current batch. A renamed or deleted document never
  // appears here, so its previously promoted memory survives indefinitely.
  // Full index-lifecycle reconciliation (retire memories whose source
  // document no longer exists in the docgraph index) belongs in the reindex
  // path, not in the per-batch handler, and is tracked separately.
  //
  // TODO(#314): add reconciliation at reindex time to retire stale dag:*
  // memories for documents that no longer exist in the index.

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
        const embedding = ctx.generateEmbedding
          ? await ctx.generateEmbedding(`${memory.title}. ${memory.content}`)
          : null;

        // Recheck cancellation after the (potentially slow) embedding call —
        // the caller may have disconnected during a Voyage or local-transform
        // inference, and proceeding to a DB mutation would be wasted work.
        if (signal?.aborted) break;

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
          // recall is eventually restored (#314).
          if (!embedding) {
            ctx.embeddingQueue?.enqueue(updated.id, `${memory.title}. ${memory.content}`);
          }
        } else {
          const created = await ctx.store.insert(input, embedding);
          if (!embedding) {
            ctx.embeddingQueue?.enqueue(created.id, `${memory.title}. ${memory.content}`);
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

// ─── Public exports ───────────────────────────────────────────────────────────
export const searchHandler     = safeHandler('search',     _search);
export const reposHandler      = safeHandler('repos',      _repos);
export const manifestHandler   = safeHandler('manifest',   _manifest);
export const batchHandler      = safeHandler('batch',      _batch);
export const outlineHandler    = safeHandler('outline',    _outline);
export const contextHandler    = safeHandler('context',    _context);
export const refsHandler       = safeHandler('refs',       _refs);
export const deleteRepoHandler = safeHandler('deleteRepo', _deleteRepo);
