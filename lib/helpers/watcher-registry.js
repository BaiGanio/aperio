// lib/helpers/watcher-registry.js
// Tracks live code/doc-graph watcher handles keyed by (kind, root). Both the
// boot pass and runtime "add a folder" route register here, so:
//   • DELETE /api/{code,doc}graph/repos can stop the matching watcher
//     immediately — otherwise it keeps watching a removed folder and resurrects
//     it on the next file change.
//   • shutdown can stop every watcher (boot + runtime-added) in one sweep.
// kind is 'codegraph' | 'docgraph'; a single folder may be watched by both, so
// each kind keeps its own root→handle map.

export function createWatcherRegistry() {
  const byKind = new Map(); // kind -> Map<root, handle>
  let closed = false;       // set once stopAll() has swept; blocks late registers
  const mapFor = (kind) => {
    let m = byKind.get(kind);
    if (!m) byKind.set(kind, (m = new Map()));
    return m;
  };

  return {
    // Replace any existing watcher for the same (kind, root), stopping the stale
    // one so we never leak two watchers on a single folder.
    async register(kind, root, handle) {
      // Shutdown may sweep the registry (stopAll) while a boot index is still
      // finishing its initial pass. When that pass finally registers its handle
      // here, the registry is already closed — stop the watcher on arrival so it
      // doesn't leak and keep the event loop alive past exit.
      if (closed) { await handle?.stop?.().catch(() => {}); return; }
      const m = mapFor(kind);
      const prev = m.get(root);
      m.set(root, handle);
      if (prev && prev !== handle) await prev.stop?.().catch(() => {});
    },
    // Stop and forget the watcher for (kind, root). Returns false if none.
    async stop(kind, root) {
      const m = mapFor(kind);
      const handle = m.get(root);
      if (!handle) return false;
      m.delete(root);
      await handle.stop?.();
      return true;
    },
    async stopAll() {
      closed = true;
      const handles = [];
      for (const m of byKind.values()) { for (const h of m.values()) handles.push(h); m.clear(); }
      await Promise.allSettled(handles.map((h) => h?.stop?.()));
    },
    has: (kind, root) => mapFor(kind).has(root),
  };
}
