export function recallAt(retrieved, relevant, k) {
  const expected = new Set((relevant ?? []).map(String));
  if (!expected.size) return null;
  return retrieved.slice(0, k).some(row => expected.has(String(row.id))) ? 1 : 0;
}

export function reciprocalRank(retrieved, relevant) {
  const expected = new Set((relevant ?? []).map(String));
  const rank = retrieved.findIndex(row => expected.has(String(row.id)));
  return rank < 0 ? 0 : 1 / (rank + 1);
}

export function macroF1(predictions, labels) {
  const classes = new Set([...predictions, ...labels].map(String));
  if (!classes.size) return 0;
  let total = 0;
  for (const cls of classes) {
    let tp = 0, fp = 0, fn = 0;
    for (let i = 0; i < labels.length; i++) {
      if (String(labels[i]) === cls && String(predictions[i]) === cls) tp++;
      else if (String(labels[i]) !== cls && String(predictions[i]) === cls) fp++;
      else if (String(labels[i]) === cls) fn++;
    }
    total += tp ? (2 * tp) / (2 * tp + fp + fn) : 0;
  }
  return total / classes.size;
}

export function summarizeResults(results) {
  const retrieval = results.filter(r => r.retrievedIds);
  const avg = key => retrieval.length ? retrieval.reduce((n, r) => n + (Number(r[key]) || 0), 0) / retrieval.length : 0;
  const classification = results.filter(r => r.label !== undefined);
  const qa = results.filter(r => r.answerable !== undefined);
  return {
    queries: results.length, retrievalQueries: retrieval.length,
    recallAt1: avg("recallAt1"), recallAt5: avg("recallAt5"), recallAt10: avg("recallAt10"),
    mrr: avg("mrr"), meanLatencyMs: avg("latencyMs"),
    emptyResultCount: retrieval.filter(r => !r.retrievedIds.length).length,
    embeddingFailureCount: results.filter(r => r.embeddingFailed).length,
    macroF1: classification.length ? macroF1(classification.map(r => r.predictedLabel), classification.map(r => r.label)) : null,
    answerabilityAccuracy: qa.length ? qa.filter(r => Boolean(r.answerable) === Boolean(r.retrievedIds.length > 0)).length / qa.length : null,
  };
}
