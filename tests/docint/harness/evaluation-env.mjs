// Small runtime helpers for the live document-intelligence harness. Kept
// separate from the entrypoint so capability setup and cleanup orchestration
// can be tested without booting Aperio, binding ports, or starting a model.

export function includeEvaluationModelInCapableModels(rawModels, evaluationModel) {
  const model = String(evaluationModel ?? "").trim();
  if (!model) throw new Error("A llama.cpp evaluation model is required");

  const models = String(rawModels ?? "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  if (!models.some(value => value.toLowerCase() === model.toLowerCase())) {
    models.push(model);
  }
  return models.join(",");
}

export async function cleanupEvaluationExtraction(store, {
  extractionDbPath,
  deleteExtractionFile,
  log = () => {},
} = {}) {
  if (!store) return null;
  const file = extractionDbPath(store);
  await deleteExtractionFile(file);
  log(file);
  return file;
}
