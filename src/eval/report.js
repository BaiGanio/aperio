// src/eval/report.js — the baseline / result report (spec S2.1 §3). Every
// model carries train AND holdout (L-M10); every score carries its spread
// (L-M11); latency carries max and event-loop lag (L-C16). A report missing
// any of that is refused, by path, before it is written.

const META_FIELDS = ['target', 'commit', 'date', 'runs', 'seed', 'temperature', 'k'];
const SPLITS = ['train', 'holdout'];
const SUMMARY_FIELDS = ['n', 'mean', 'stdev', 'min', 'max'];
const LATENCY_FIELDS = ['n', 'meanMs', 'stdevMs', 'p95Ms', 'maxMs', 'maxEventLoopLagMs'];

function need(obj, field, path) {
  if (obj?.[field] === undefined || obj[field] === null) throw new Error(`eval report: missing ${path}.${field}`);
  return obj[field];
}

function checkSummary(sum, path) {
  for (const f of SUMMARY_FIELDS) {
    const v = need(sum, f, path);
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`eval report: ${path}.${f} is not a number`);
  }
}

function checkSplit(block, path, k) {
  const recallKey = `hitRateAt${k}`;
  const recall = need(block, recallKey, path);
  const modes = Object.keys(recall);
  if (modes.length === 0) throw new Error(`eval report: ${path}.${recallKey} has no search mode`);
  for (const mode of modes) checkSummary(recall[mode], `${path}.${recallKey}.${mode}`);
  checkSummary(need(block, 'usedWithoutHint', path), `${path}.usedWithoutHint`);
  checkSummary(need(block, 'toolSuccess', path), `${path}.toolSuccess`);
  const latency = need(block, 'latency', path);
  for (const f of LATENCY_FIELDS) need(latency, f, `${path}.latency`);
  need(block, 'emptyRetry', path);
}

/** Throws with the path of the first missing or malformed field. */
export function validateReport(report) {
  for (const f of META_FIELDS) need(report, f, 'report');
  const models = need(report, 'models', 'report');
  if (!Array.isArray(models) || models.length === 0) throw new Error('eval report: no models');
  for (const [i, model] of models.entries()) {
    const id = need(model, 'id', `models[${i}]`);
    const splits = need(model, 'splits', `models[${id}]`);
    for (const split of SPLITS) checkSplit(need(splits, split, `models[${id}].splits`), `models[${id}].splits.${split}`, report.k);
  }
  return report;
}

/**
 * @param {{target: string, commit: string, date: string, runs: number, seed: number, temperature: number, k: number}} meta
 * @param {{id: string, splits: {train: object, holdout: object}}[]} models
 */
export function buildReport(meta, models) {
  return validateReport({ schema: 1, ...meta, models });
}
