// lib/codegraph/status.js
// Shared status object for the initial codegraph index. The server boots the
// indexer in the background (so the API + UI come up immediately) and the
// watcher updates this object as it progresses. The /api/codegraph/status
// route surfaces it to the frontend so the Code panel can show a progress
// banner instead of looking broken.

const state = {
  enabled: false,      // true when APERIO_CODEGRAPH=on and the backend supports it
  phase: 'idle',       // 'idle' | 'indexing' | 'ready' | 'error'
  startedAt: null,     // ISO timestamp when indexing began
  completedAt: null,   // ISO timestamp when indexing finished
  roots: [],           // [{ path, phase, files, symbols, edges, error }]
  error: null,         // last error message (if phase === 'error')
};

export function getCodegraphStatus() {
  return JSON.parse(JSON.stringify(state));
}

export function markEnabled(roots) {
  state.enabled = true;
  state.phase = 'indexing';
  state.startedAt = new Date().toISOString();
  state.roots = roots.map(path => ({ path, phase: 'pending', files: 0, symbols: 0, edges: 0, error: null }));
}

export function markRootStarted(path) {
  const r = state.roots.find(r => r.path === path);
  if (r) r.phase = 'indexing';
}

// Live progress while a root is still indexing — lets the UI show running
// file/symbol counts instead of a black box until the whole root commits.
export function markRootProgress(path, counts) {
  const r = state.roots.find(r => r.path === path);
  if (!r || r.phase === 'ready') return;
  r.files = counts?.files ?? r.files;
  r.symbols = counts?.symbols ?? r.symbols;
  r.edges = counts?.edges ?? r.edges;
}

export function markRootDone(path, counts) {
  const r = state.roots.find(r => r.path === path);
  if (!r) return;
  r.phase = 'ready';
  r.files = counts?.files ?? 0;
  r.symbols = counts?.symbols ?? 0;
  r.edges = counts?.edges ?? 0;
}

export function markRootError(path, err) {
  const r = state.roots.find(r => r.path === path);
  if (r) { r.phase = 'error'; r.error = err?.message ?? String(err); }
  state.error = err?.message ?? String(err);
}

export function markAllDone() {
  // Don't flip to 'ready' while roots are still pending/indexing — with several
  // folders added separately, each one's completion calls this, and an earlier
  // call must not declare the whole graph done before the rest finish.
  const anyError  = state.roots.some(r => r.phase === 'error');
  const anyActive = state.roots.some(r => r.phase === 'pending' || r.phase === 'indexing');
  state.phase = anyError ? 'error' : anyActive ? 'indexing' : 'ready';
  if (!anyActive) state.completedAt = new Date().toISOString();
}

// User-driven: add a new root to track. Flips overall phase back to 'indexing'.
export function addRoot(path) {
  if (state.roots.some(r => r.path === path)) return;
  state.roots.push({ path, phase: 'pending', files: 0, symbols: 0, edges: 0, error: null });
  state.enabled = true;
  state.phase = 'indexing';
  if (!state.startedAt) state.startedAt = new Date().toISOString();
  state.completedAt = null;
}
