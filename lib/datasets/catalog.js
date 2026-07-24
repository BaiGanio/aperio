// Curated Hugging Face dataset contracts used by Dataset Lab.
// Keep this registry explicit: arbitrary Hub schemas are not benchmark inputs.

const BEIR = (id, purpose, license, citation, recommendedLimit = 1000) => ({
  id, task: "retrieval", purpose, license, citation, recommendedLimit,
  configs: ["corpus", "queries", "qrels"], splits: ["test"],
  normalize: normalizeBeir,
});

export const DATASET_CATALOG = Object.freeze({
  "BeIR/scifact": BEIR("BeIR/scifact", "scientific claim-to-evidence retrieval", "cc-by-sa-4.0", "Wadden et al., SciFact (2020)", 5000),
  "BeIR/nfcorpus": BEIR("BeIR/nfcorpus", "biomedical passage retrieval", "unknown", "Boteva et al., NFCorpus (2016)", 5000),
  "BeIR/arguana": BEIR("BeIR/arguana", "counterargument retrieval", "unknown", "Clavié and Hidey, ArguAna (2023)", 10000),
  "BeIR/quora": BEIR("BeIR/quora", "duplicate-question retrieval", "cc-by-sa-4.0", "Thakur et al., BEIR (2021)", 10000),
  "BeIR/trec-covid": BEIR("BeIR/trec-covid", "bounded large-scale retrieval", "unknown", "Voorhees et al., TREC-COVID (2020)", 20000),
  "rajpurkar/squad_v2": {
    id: "rajpurkar/squad_v2", task: "qa", purpose: "answerability and evidence selection", license: "cc-by-sa-4.0",
    citation: "Rajpurkar et al., SQuAD 2.0 (2018)", configs: ["default"], splits: ["train", "validation"], recommendedLimit: 1000, normalize: normalizeSquad,
  },
  "PolyAI/banking77": {
    id: "PolyAI/banking77", task: "classification", purpose: "fine-grained intent classification", license: "cc-by-4.0",
    citation: "Casanueva et al., Banking77 (2020)", configs: ["default"], splits: ["train", "test"], recommendedLimit: 1000, normalize: normalizeBanking,
  },
  "openlanguagedata/flores_plus": {
    id: "openlanguagedata/flores_plus", task: "translation", purpose: "optional multilingual evaluation reference", license: "gated-evaluation-only",
    citation: "FLORES+ dataset card", configs: ["default"], splits: ["dev"], recommendedLimit: 500, normalize: normalizeFlores,
  },
});

function required(row, keys, id) {
  for (const key of keys) if (typeof row?.[key] === "string" && row[key].trim()) return row[key].trim();
  throw new Error(`${id}: row is missing required field (${keys.join(" or ")})`);
}

function normalizeBeir(row, meta = {}) {
  const query = required(row, ["text", "query", "question"], meta.id);
  const documents = row.documents ?? [row.document ?? row.doc ?? row];
  const normalizedDocuments = documents.map(document => {
    const text = required(document, ["text", "contents", "content", "body"], meta.id);
    const id = String(document.id ?? document._id ?? row.docid ?? row.document_id ?? row.id ?? "");
    if (!id) throw new Error(`${meta.id}: corpus row has no document id`);
    return { id, title: document.title ?? "", text };
  });
  const relevant = row.relevantDocumentIds ?? row.relevant_ids ?? (row.qrels ? Object.keys(row.qrels) : []);
  return { queryId: String(row.queryId ?? row.query_id ?? row.qid ?? row.id ?? ""), query, documents: normalizedDocuments, relevantDocumentIds: relevant.map(String), metadata: meta };
}

function normalizeSquad(row, meta = {}) {
  const question = required(row, ["question"], meta.id);
  const answers = row.answers ?? { text: [], answer_start: [] };
  const context = required(row, ["context"], meta.id);
  return { queryId: String(row.id ?? row.question_id ?? ""), query: question, documents: [{ id: String(row.id ?? row.title ?? "context"), title: row.title ?? "", text: context }], relevantDocumentIds: answers.text?.length ? [String(row.id ?? row.title ?? "context")] : [], answerable: answers.text?.length > 0, metadata: meta };
}

function normalizeBanking(row, meta = {}) {
  const query = required(row, ["text"], meta.id);
  if (row.label === undefined) throw new Error(`${meta.id}: classification row has no label`);
  const label = String(row.label);
  return { queryId: String(row.id ?? query), query, label, documents: [{ id: label, title: label, text: query }], relevantDocumentIds: [label], metadata: { ...meta, task: "classification" } };
}

function normalizeFlores(row, meta = {}) {
  const text = required(row, ["sentence", "text"], meta.id);
  return { queryId: String(row.id ?? text.slice(0, 24)), query: text, documents: [], relevantDocumentIds: [], metadata: meta };
}

export function getDataset(id) {
  const dataset = DATASET_CATALOG[id];
  if (!dataset) throw new Error(`Unsupported dataset: ${id}`);
  return dataset;
}

export function catalogList() { return Object.values(DATASET_CATALOG); }

export function normalizeRows(datasetId, rows, metadata = {}) {
  const adapter = getDataset(datasetId);
  if (!Array.isArray(rows)) throw new Error(`${datasetId}: rows must be an array`);
  return rows.map(row => adapter.normalize(row, { ...metadata, dataset: datasetId }));
}
