// lib/docgraph/facts/index.js
// Deterministic document-fact pipeline (issue #250).
//
//   documents → factsFromDocuments() → reconcileFacts() → aggregateFacts()
//
// The model's job on the other side of this is to identify and explain, not
// to add. Nothing here calls a provider, and the same documents always
// produce the same totals.

export { FACT_LIMITS, TERMINAL_AMOUNT_LABELS, EVIDENCE_KINDS, CATEGORY_RULES,
  classifyCategory, categoryByName, isCommercialDocument, detectEvidenceKind,
  extractLocators, extractMerchant, resolveAssignmentDate, createFact } from "./contract.js";
export { isStatementLike, parseStatementRows, statementCurrency } from "./statement.js";
export { factsFromDocument, factsFromDocuments } from "./extract.js";
export { reconcileFacts, aggregateFacts } from "./aggregate.js";
export { toMinor, fromMinor, sumMinor, formatMinor } from "./money.js";

import { factsFromDocuments } from "./extract.js";
import { aggregateFacts } from "./aggregate.js";

/**
 * The whole pipeline in one call: documents in, settled totals out.
 *
 * `documents` may be the pipeline's own records ({document, root, ...}) or
 * doc_batch records ({rel_path, root_path, ...}) — factsFromDocument
 * normalizes both shapes (see extract.js), so a doc_batch result can be
 * handed to this function directly.
 *
 * @param {Array<{document?: string, root?: string, rel_path?: string, root_path?: string, title?: string, text: string}>} documents
 * @param {{period?: string|null, baseCurrency?: string|null}} [opts]
 */
export function aggregateDocuments(documents, opts = {}) {
  const { facts, excluded, truncated } = factsFromDocuments(documents);
  const result = aggregateFacts(facts, {
    ...opts,
    excluded,
    documentsSeen: (documents ?? []).length,
  });
  if (truncated) result.coverage.truncated = true;
  return result;
}
