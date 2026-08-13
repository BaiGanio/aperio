import crypto from 'node:crypto';

const ID = /^[a-z][a-z0-9-]*(?:\.[A-Za-z0-9:_-]+)+$/;
const FACTUAL_FIELDS = new Set(['id', 'family', 'name', 'value', 'default', 'status', 'source', 'sourceBlob', 'productSha']);

export function stableId(family, key) {
  const escaped = String(key).trim().replace(/[^A-Za-z0-9:_-]+/g, '-').replace(/^-|-$/g, '');
  const id = `${family}.${escaped}`;
  if (!ID.test(id)) throw new Error(`invalid stable ID: ${id}`);
  return id;
}

export function normalizeDataset(rows, provenance) {
  const ids = new Set();
  const normalized = rows.map((row) => {
    if (!ID.test(row.id)) throw new Error(`invalid stable ID: ${row.id}`);
    if (ids.has(row.id)) throw new Error(`duplicate stable ID: ${row.id}`);
    ids.add(row.id);
    return Object.freeze({ ...row });
  }).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const semantic = JSON.stringify({ rows: normalized, provenance: { ...provenance, generatedAt: undefined } });
  return Object.freeze({
    rows: Object.freeze(normalized),
    provenance: Object.freeze({ ...provenance, semanticHash: crypto.createHash('sha256').update(semantic).digest('hex') })
  });
}

export function project(dataset, query) {
  const allowed = new Set(['family', 'ids', 'status']);
  for (const key of Object.keys(query)) if (!allowed.has(key)) throw new Error(`invalid projection predicate: ${key}`);
  let rows = dataset.rows;
  if (query.family) rows = rows.filter((row) => row.family === query.family);
  if (query.status) rows = rows.filter((row) => row.status === query.status);
  if (query.ids) {
    const wanted = new Set(query.ids);
    rows = rows.filter((row) => wanted.has(row.id));
    for (const id of wanted) if (!dataset.rows.some((row) => row.id === id)) throw new Error(`unknown projection ID: ${id}`);
  }
  if (!rows.length && !query.allowEmptyReason) throw new Error('unexplained empty projection');
  return rows;
}

export function applyOverlay(row, overlay) {
  for (const key of Object.keys(overlay)) {
    if (FACTUAL_FIELDS.has(key)) throw new Error(`factual overlay write: ${key}`);
  }
  return Object.freeze({ ...row, overlay: Object.freeze({ ...overlay }) });
}
