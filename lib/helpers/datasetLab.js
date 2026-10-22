import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getDataset, normalizeRows } from "../datasets/catalog.js";
import { recallAt, reciprocalRank, summarizeResults } from "./datasetMetrics.js";

const DEFAULT_ROOT = resolve(process.cwd(), "var/benchmarks/datasets");
const tokens = text => String(text ?? "").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const lexical = (query, text) => { const q = new Set(tokens(query)); const d = tokens(text); return d.length ? d.filter(t => q.has(t)).length / Math.sqrt(d.length) : 0; };
const fingerprint = ({ provider = "transformers", model = "mixedbread-ai/mxbai-embed-large-v1", dims = Number(process.env.EMBEDDING_DIMS || 1024) } = {}) => ({ provider, model, dims });

async function loadRows({ dataset, split, limit, fetchImpl = fetch }) {
  const adapter = getDataset(dataset);
  if (adapter.task === "retrieval") return loadBeirRows({ dataset, split, limit, fetchImpl });
  const out = [];
  const configs = ["default"];
  for (const config of configs) {
    const url = new URL("https://datasets-server.huggingface.co/rows");
    url.searchParams.set("dataset", dataset); url.searchParams.set("config", config); url.searchParams.set("split", split); url.searchParams.set("offset", "0"); url.searchParams.set("length", String(Math.min(limit, 100)));
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`Unable to load ${dataset}/${config}/${split}: HTTP ${response.status}`);
    const body = await response.json();
    out.push(...(body.rows ?? []).map(item => item.row));
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

async function loadBeirRows({ dataset, split, limit, fetchImpl }) {
  async function page(config, requestedSplit, length) {
    const url = new URL("https://datasets-server.huggingface.co/rows");
    url.searchParams.set("dataset", dataset); url.searchParams.set("config", config); url.searchParams.set("split", requestedSplit); url.searchParams.set("offset", "0"); url.searchParams.set("length", String(Math.min(length, 100)));
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`Unable to load ${dataset}/${config}/${requestedSplit}: HTTP ${response.status}`);
    return (await response.json()).rows?.map(item => item.row) ?? [];
  }
  const corpus = await page("corpus", "corpus", getDataset(dataset).recommendedLimit);
  const queries = await page("queries", "queries", limit);
  const qrels = await page("qrels", split, Math.max(limit * 5, 100));
  const documents = corpus.map(row => ({ id: String(row._id ?? row.id ?? row.docid ?? ""), title: row.title ?? "", text: row.text ?? row.contents ?? row.content ?? "" })).filter(row => row.id && row.text);
  const relevant = new Map();
  for (const row of qrels) { const qid = String(row["query-id"] ?? row.query_id ?? row.qid ?? ""); const did = String(row["corpus-id"] ?? row.docid ?? row.document_id ?? ""); if (qid && did && Number(row.score ?? 1) > 0) relevant.set(qid, [...(relevant.get(qid) ?? []), did]); }
  return queries.slice(0, limit).map(row => ({ query_id: row["_id"] ?? row.id ?? row.query_id, text: row.text ?? row.query, document: documents[0] ?? { id: "", text: "" }, documents, relevantDocumentIds: relevant.get(String(row["_id"] ?? row.id ?? row.query_id)) ?? [] }));
}

export async function runDatasetExperiment({ dataset, split, rows, limit = 100, modes = ["fulltext", "vector", "hybrid"], topK = [1, 5, 10], embeddingFn, fetchImpl, root = DEFAULT_ROOT, revision = "main", embeddingFingerprint } = {}) {
  const startedAt = new Date().toISOString();
  const metadata = { dataset, revision, split, license: getDataset(dataset).license, citation: getDataset(dataset).citation };
  const raw = rows ?? await loadRows({ dataset, split, limit, fetchImpl });
  const normalized = normalizeRows(dataset, raw, metadata).slice(0, Math.min(limit, 10000));
  const docs = normalized.flatMap(q => q.documents ?? []).filter((doc, i, all) => all.findIndex(other => other.id === doc.id) === i);
  const docVectors = new Map();
  if (embeddingFn && modes.some(m => m === "vector" || m === "hybrid")) for (const doc of docs) { const v = await embeddingFn(`${doc.title}. ${doc.text}`); if (v) docVectors.set(doc.id, v); }
  const results = [];
  for (const mode of modes) for (const item of normalized) {
    if (!item.documents?.length) continue;
    const t0 = performance.now();
    let queryVector = null; let embeddingFailed = false;
    if ((mode === "vector" || mode === "hybrid") && embeddingFn) { queryVector = await embeddingFn(item.query, "query"); embeddingFailed = !queryVector; }
    const lexicalRows = docs.map(doc => ({ ...doc, score: lexical(item.query, `${doc.title} ${doc.text}`) })).filter(r => r.score > 0).sort((a,b) => b.score-a.score);
    let vectorRows = [];
    if (queryVector) vectorRows = docs.map(doc => ({ ...doc, score: cosine(queryVector, docVectors.get(doc.id)) })).filter(r => r.score > -1).sort((a,b) => b.score-a.score);
    const ranked = mode === "fulltext" ? lexicalRows : mode === "vector" ? vectorRows : fuse(lexicalRows, vectorRows);
    const retrieved = ranked.slice(0, Math.max(...topK, 10)).map(({ id, title, text, score }) => ({ id, title, text, score }));
    results.push({ queryId: item.queryId, query: item.query, mode, label: item.label, answerable: item.answerable, predictedLabel: item.label === undefined ? undefined : (retrieved[0]?.id ?? null), retrievedIds: retrieved.map(r => r.id), retrieved, relevantIds: item.relevantDocumentIds, firstRelevantRank: firstRank(retrieved, item.relevantDocumentIds), recallAt1: recallAt(retrieved, item.relevantDocumentIds, 1), recallAt5: recallAt(retrieved, item.relevantDocumentIds, 5), recallAt10: recallAt(retrieved, item.relevantDocumentIds, 10), mrr: reciprocalRank(retrieved, item.relevantDocumentIds), latencyMs: Math.round((performance.now() - t0) * 100) / 100, embeddingFailed, failureCategory: classifyFailure(item, retrieved) });
  }
  const artifact = { id: randomUUID(), startedAt, finishedAt: new Date().toISOString(), config: { dataset, split, limit, modes, topK }, metadata, embeddingFingerprint: embeddingFingerprint ?? fingerprint(), summary: summarizeResults(results), results };
  await mkdir(root, { recursive: true, mode: 0o700 }); await writeFile(join(root, `${artifact.id}.json`), JSON.stringify(artifact, null, 2), { mode: 0o600 });
  return artifact;
}

function cosine(a, b) { if (!a || !b || a.length !== b.length) return -1; let dot=0,na=0,nb=0; for(let i=0;i<a.length;i++){dot+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i];} return dot/(Math.sqrt(na*nb)||1); }
function fuse(a,b) { const map = new Map(); for (const [list, weight] of [[a,1],[b,1]]) list.forEach((r,i) => map.set(r.id, { ...r, score: (map.get(r.id)?.score ?? 0) + weight/(60+i+1) })); return [...map.values()].sort((x,y)=>y.score-x.score); }
function firstRank(retrieved, relevant) { const set=new Set((relevant??[]).map(String)); const i=retrieved.findIndex(r=>set.has(String(r.id))); return i<0?null:i+1; }
function classifyFailure(item, retrieved) { if (!item.relevantDocumentIds?.length) return "unanswerable-or-no-qrel"; if (!retrieved.length) return "empty-result"; if (firstRank(retrieved,item.relevantDocumentIds) === null) return "lexical-mismatch"; return null; }
export async function readDatasetArtifact(id, root = DEFAULT_ROOT) { return JSON.parse(await readFile(join(root, `${id}.json`), "utf8")); }
export function datasetArtifactRoot() { return DEFAULT_ROOT; }
