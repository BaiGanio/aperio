// src/embeddings/embed-reindex.js - embed every row whose sig is not the
// current one (spec S2.4 #6).
//
// v1 (lib/embeddings/reindex.js at archive/v1-final) kept one signature per
// store, so it needed leases, checkpoints and settle rounds. v2 keeps a sig
// per row (S2.3): "rows still to do" is one query, and a run can stop at any
// point and resume at no cost. A model change is just rows with an old sig.

const PAGE = 50;

/**
 * @param {{ vectorSupported: boolean, listNeedingEmbedding: Function, setEmbedding: Function }} store
 * @param {{ sig: string, embed: (text: string) => Promise<ArrayLike<number>> }} embedder
 * @param {{ signal?: AbortSignal, log?: { warn: Function } }} [opts]
 * @returns {Promise<{ done: number, failed: number }>}
 */
export async function reindex(store, embedder, { signal, log = console } = {}) {
  let done = 0;
  let failed = 0;
  if (!store.vectorSupported) return { done, failed };

  // A failed row keeps its old sig, so it would come back on the next page.
  // Skip it in this run; it waits for the next run.
  const skip = new Set();
  while (!signal?.aborted) {
    const page = (await store.listNeedingEmbedding(embedder.sig, PAGE + skip.size))
      .filter((row) => !skip.has(row.id))
      .slice(0, PAGE);
    if (page.length === 0) break;

    let ok = 0;
    for (const row of page) {
      if (signal?.aborted) break;
      try {
        const vector = await embedder.embed(`${row.title}. ${row.content}`);
        // A vector already made is written, even if the signal aborted meanwhile.
        if (await store.setEmbedding(row.id, vector, embedder.sig)) ok++;
      } catch (err) {
        failed++;
        skip.add(row.id);
        log.warn(`[embeddings] could not embed memory ${row.id}: ${err.message}. It stays for the next run.`);
      }
    }
    done += ok;
    if (ok === 0) break; // a page with no success: stop, do not loop
  }
  return { done, failed };
}
