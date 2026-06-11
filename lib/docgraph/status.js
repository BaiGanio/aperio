// lib/docgraph/status.js
// Shared status object for the docgraph index, mirroring lib/codegraph/status.js.
// The server boots the watcher in the background so the API comes up immediately;
// the watcher updates this object as it progresses.

const state = {
  enabled: false,      // true when APERIO_DOCGRAPH=on and the backend supports it
  phase: 'idle',       // 'idle' | 'indexing' | 'ready' | 'error'
  startedAt: null,
  completedAt: null,
  roots: [],           // [{ path, phase, docs, chunks, error }]
  error: null,
};

export function getDocgraphStatus() {
  return JSON.parse(JSON.stringify(state));
}

export function markEnabled(roots) {
  state.enabled = true;
  state.phase = 'indexing';
  state.startedAt = new Date().toISOString();
  state.roots = roots.map((path) => ({ path, phase: 'pending', docs: 0, chunks: 0, error: null }));
}

export function markRootStarted(path) {
  const r = state.roots.find((r) => r.path === path);
  if (r) r.phase = 'indexing';
}

export function markRootDone(path, counts) {
  const r = state.roots.find((r) => r.path === path);
  if (!r) return;
  r.phase = 'ready';
  r.docs = counts?.docCount ?? counts?.docs ?? 0;
  r.chunks = counts?.chunkCount ?? counts?.chunks ?? 0;
}

export function markRootError(path, err) {
  const r = state.roots.find((r) => r.path === path);
  if (r) { r.phase = 'error'; r.error = err?.message ?? String(err); }
  state.error = err?.message ?? String(err);
}

export function markAllDone() {
  state.phase = state.roots.some((r) => r.phase === 'error') ? 'error' : 'ready';
  state.completedAt = new Date().toISOString();
}

export function addRoot(path) {
  if (state.roots.some((r) => r.path === path)) return;
  state.roots.push({ path, phase: 'pending', docs: 0, chunks: 0, error: null });
  state.enabled = true;
  state.phase = 'indexing';
  if (!state.startedAt) state.startedAt = new Date().toISOString();
  state.completedAt = null;
}
