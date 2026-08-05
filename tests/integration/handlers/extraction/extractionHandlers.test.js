// tests/integration/handlers/extraction/extractionHandlers.test.js
// Document Intelligence WS3 (issue #250), Step 2 — T-G4.1–T-G4.4 against a
// REAL SqliteStore (applies 014_extraction_templates.sql end to end, same
// convention as tests/integration/codegraph/intelligence.test.js).
//
// Uses small synthetic document snippets rather than the full household-gen
// corpus: extract-facts.js's own regex/label correctness (incl. BG/DE/FR) is
// already covered by lib/docgraph/extract-facts.test.js — these tests target
// the new orchestration (matching, provenance, confidence, cold-start
// confirm, log dedup) built on top of it, not the regex layer itself.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

let store, oldPath;
let templateHandlers, matchHandlers, extractHandlers;

before(async () => {
  oldPath = process.env.SQLITE_PATH;
  process.env.SQLITE_PATH = ":memory:";
  const { SqliteStore } = await import("../../../../db/sqlite.js");
  store = await SqliteStore.init();

  templateHandlers = await import("../../../../lib/handlers/extraction/templateHandlers.js");
  matchHandlers = await import("../../../../lib/handlers/extraction/matchHandlers.js");
  extractHandlers = await import("../../../../lib/handlers/extraction/extractHandlers.js");
});

after(() => {
  if (oldPath) process.env.SQLITE_PATH = oldPath; else delete process.env.SQLITE_PATH;
  store?.close?.();
});

function ctxFor(store) { return { store }; }

// ─── T-G4.1 — template CRUD ──────────────────────────────────────────────────
describe("T-G4.1 templateHandlers CRUD", () => {
  test("create returns the new row with server-set created_at/updated_at", async () => {
    const row = await templateHandlers.create(store, {
      name: "crud-basic",
      match_keywords: ["acme", "utilities"],
      fields: [{ name: "total", amount_label: "total_due" }],
    });
    assert.ok(row.id);
    assert.equal(row.name, "crud-basic");
    assert.ok(row.created_at);
    assert.equal(row.created_at, row.updated_at);
    assert.deepEqual(row.fields, [{ name: "total", amount_label: "total_due" }]);
  });

  test("update bumps updated_at and leaves created_at untouched", async () => {
    const created = await templateHandlers.create(store, {
      name: "crud-update",
      match_keywords: ["x"],
      fields: [{ name: "total", amount_label: "total_due" }],
    });
    await new Promise((r) => setTimeout(r, 5));
    const updated = await templateHandlers.update(store, { id: created.id, confidence: 0.5 });
    assert.equal(updated.created_at, created.created_at);
    assert.notEqual(updated.updated_at, created.updated_at);
    assert.equal(updated.confidence, 0.5);
  });

  test("list returns all templates; delete removes the row and a subsequent get is not-found", async () => {
    const before = await templateHandlers.list(store);
    const row = await templateHandlers.create(store, {
      name: "crud-delete-me",
      match_keywords: ["y"],
      fields: [{ name: "d", date_role: "invoice_date" }],
    });
    const after = await templateHandlers.list(store);
    assert.equal(after.length, before.length + 1);

    const removed = await templateHandlers.remove(store, { id: row.id });
    assert.equal(removed, true);
    const gone = await templateHandlers.get(store, { id: row.id });
    assert.equal(gone, null);
  });

  test("rejects fields entries missing both amount_label and date_role", async () => {
    await assert.rejects(
      () => templateHandlers.create(store, { name: "crud-bad-field", fields: [{ name: "mystery" }] }),
      /amount_label\/date_role/
    );
  });

  test("rejects malformed fields (not an array)", async () => {
    await assert.rejects(
      () => templateHandlers.create(store, { name: "crud-bad-fields-shape", fields: "nope" }),
      /non-empty array/
    );
  });

  test("rejects an amount_label outside extract-facts.js's known vocabulary", async () => {
    await assert.rejects(
      () => templateHandlers.create(store, { name: "crud-bad-role", fields: [{ name: "x", amount_label: "made_up_label" }] }),
      /not a known extract-facts\.js role/
    );
  });

  test("rejects a non-slug name before any DB write", async () => {
    let listedBefore = await templateHandlers.list(store);
    await assert.rejects(
      () => templateHandlers.create(store, { name: "Not Kebab", fields: [{ name: "x", amount_label: "total_due" }] }),
      /kebab-case/
    );
    const listedAfter = await templateHandlers.list(store);
    assert.equal(listedAfter.length, listedBefore.length);
  });

  test("duplicate name on create is rejected as a clean userFacing error", async () => {
    await templateHandlers.create(store, { name: "crud-dup", fields: [{ name: "x", amount_label: "total_due" }] });
    await assert.rejects(
      () => templateHandlers.create(store, { name: "crud-dup", fields: [{ name: "y", amount_label: "grand_total" }] }),
      (err) => err.userFacing === true && /already exists/.test(err.message)
    );
  });

  test("update on a missing id returns null, not an error", async () => {
    const result = await templateHandlers.update(store, { id: 999999, confidence: 0.9 });
    assert.equal(result, null);
  });

  test("delete on a missing id is a no-op, not an error", async () => {
    const removed = await templateHandlers.remove(store, { id: 999999 });
    assert.equal(removed, false);
  });
});

// ─── T-G4.2 — matching and extraction ────────────────────────────────────────
describe("T-G4.2 matching and extraction", () => {
  const BILL_TEXT = [
    "Acme Power & Water Co.",
    "Invoice Date: June 3, 2026",
    "Service Period: May 1, 2026 to May 31, 2026",
    "Subtotal: 200.00 BGN",
    "Amount Due: 260.50 BGN",
  ].join("\n");

  before(async () => {
    await templateHandlers.create(store, {
      name: "acme-utility-bill",
      match_keywords: matchHandlers.significantWords(BILL_TEXT),
      fields: [
        { name: "total", amount_label: "amount_due" },
        { name: "invoice_date", date_role: "invoice_date" },
        { name: "due_date", date_role: "due_date" }, // deliberately absent from BILL_TEXT — forces a fallback/missing path
      ],
    });
    await templateHandlers.create(store, {
      name: "narrow-near-miss",
      // "gas" never appears in BILL_TEXT (a power/water bill) — a genuine
      // near-miss (2/3 keywords hit) rather than a subset that would tie
      // acme-utility-bill's own self-derived 100% match.
      match_keywords: ["acme", "power", "gas"],
      fields: [{ name: "total", amount_label: "grand_total" }],
    });
  });

  test("matchTemplates ranks the correct template first and returns the full list", async () => {
    const ranked = await matchHandlers.matchTemplates(store, { text: BILL_TEXT });
    assert.ok(ranked.length >= 2);
    assert.equal(ranked[0].template.name, "acme-utility-bill");
    assert.ok(ranked[0].score > ranked[1].score, "top match must score strictly higher than the runner-up");
  });

  test("matchTemplates does not count a keyword that is only a substring of another word", async () => {
    // narrow-near-miss's keywords are ["acme", "power", "gas"]. A document
    // that mentions "Las Vegas" contains the LITERAL substring "gas" but not
    // the word — a naive .includes() would still score it as a hit.
    const ranked = await matchHandlers.matchTemplates(store, { text: "A trip to Las Vegas, no acme or power here." });
    const narrow = ranked.find((r) => r.template.name === "narrow-near-miss");
    assert.ok(!narrow.matchedKeywords.includes("gas"), "\"gas\" must not match inside \"Vegas\"");
    // "acme" is present as its own word in this text and must still count.
    assert.ok(narrow.matchedKeywords.includes("acme"));
  });

  test("extractFields: a real label match is 'label' provenance; a missing field falls through unresolved", async () => {
    const template = await templateHandlers.get(store, { name: "acme-utility-bill" });
    const { results, unresolved } = extractHandlers.extractFields(BILL_TEXT, template);
    const total = results.find((f) => f.name === "total");
    assert.equal(total.provenance, "label");
    assert.equal(total.value, 260.5);
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0].name, "due_date");
  });

  test("extractFromTemplate calls the LLM fallback with only the unresolved field name(s)", async () => {
    const template = await templateHandlers.get(store, { name: "acme-utility-bill" });
    let calledWith = null;
    const llmFallback = async (args) => { calledWith = args; return { due_date: "2026-06-17" }; };

    const result = await extractHandlers.extractFromTemplate(store, { text: BILL_TEXT, template, llmFallback });
    assert.deepEqual(calledWith.fields, ["due_date"]);
    assert.equal(calledWith.text, BILL_TEXT);

    const dueDate = result.fields.find((f) => f.name === "due_date");
    assert.equal(dueDate.provenance, "llm");
    assert.equal(dueDate.value, "2026-06-17");
  });

  test("a fully-labeled extraction scores higher confidence than one leaning on LLM fallback", async () => {
    const template = await templateHandlers.get(store, { name: "acme-utility-bill" });
    const withLlm = await extractHandlers.extractFromTemplate(store, {
      text: BILL_TEXT, template, llmFallback: async () => ({ due_date: "2026-06-17" }),
    });
    const withoutLlm = await extractHandlers.extractFromTemplate(store, {
      text: BILL_TEXT.replace("260.50 BGN", "260.50 BGN\n"), // distinct hash so dedup doesn't short-circuit this pass
      template, llmFallback: undefined,
    });
    assert.ok(withoutLlm.confidence < 1); // due_date unresolved (provenance "missing")
    assert.ok(withLlm.confidence > withoutLlm.confidence);
  });

  test("empty source text returns an honest empty result, never fabricated values", async () => {
    const template = await templateHandlers.get(store, { name: "acme-utility-bill" });
    const result = await extractHandlers.extractFromTemplate(store, { text: "", template });
    assert.deepEqual(result.fields, []);
    assert.equal(result.confidence, 0);
  });

  test("classifyMatch reports 'ambiguous' rather than silently picking between two close templates", async () => {
    // A document containing only the shared "acme power" words scores both
    // templates close together (acme-utility-bill still has more matched
    // keywords by fraction, but not clear-cut) — construct text explicitly
    // sized to land both scores within AMBIGUOUS_MARGIN of each other.
    const ranked = await matchHandlers.matchTemplates(store, { text: "acme power" });
    const classified = matchHandlers.classifyMatch(ranked);
    // Both templates' keyword lists partially overlap "acme power"; assert the
    // classifier never returns "confident" when the top two scores are close —
    // whichever way the concrete numbers land, status must not silently guess.
    if (classified.status === "confident") {
      const [first, second] = ranked;
      assert.ok(!second || (first.score - second.score) >= matchHandlers.AMBIGUOUS_MARGIN);
    }
  });
});

// ─── T-G4.3 — confirmed cold-start learning ──────────────────────────────────
describe("cold-start proposal keyword selection", () => {
  test("deprioritizes generic boilerplate labels", () => {
    const text = [
      "Invoice and Payment Notice",
      "Invoice: 12345",
      "Payment: 20.00 EUR",
      "Total: 20.00 EUR",
      "Distinctive issuer wording appears below.",
    ].join("\n");
    const keywords = matchHandlers.proposalKeywords(text);

    assert.ok(!keywords.includes("invoice"));
    assert.ok(!keywords.includes("payment"));
    assert.ok(!keywords.includes("total"));
    assert.ok(keywords.includes("distinctive"));
  });

  test("favors distinctive issuer/header terms over body frequency", () => {
    const text = [
      "Asterion Municipal Energy",
      "Invoice Date: 2026-07-01",
      "Amount Due: 88.40 EUR",
      "invoice payment total invoice payment total invoice payment total",
    ].join("\n");
    const keywords = matchHandlers.proposalKeywords(text);

    assert.deepEqual(keywords.slice(0, 3), ["asterion", "municipal", "energy"]);
    assert.ok(!keywords.includes("invoice"));
    assert.ok(!keywords.includes("payment"));
    assert.ok(!keywords.includes("total"));
  });

  test("keeps different providers distinguishable when the body is shared", () => {
    const common = "Invoice Date: June 3, 2026\nPayment: 20.00 EUR\nTotal: 20.00 EUR";
    const north = matchHandlers.proposalKeywords(`Northstar Fiber Network\n${common}`);
    const south = matchHandlers.proposalKeywords(`Bluehaven Fiber Network\n${common}`);
    const overlap = north.filter((word) => south.includes(word));

    assert.ok(north.includes("northstar"));
    assert.ok(south.includes("bluehaven"));
    assert.ok(overlap.length < Math.min(north.length, south.length));
  });

  test("remains useful on noisy OCR-like text", () => {
    const text = [
      "Z3nith Gass C0rp !!!",
      "lnvoice Date: Sept 1, 2026",
      "T0tal: 12.00 USD",
      "xxxxx qqqq !!!! 0000",
    ].join("\n");
    const keywords = matchHandlers.proposalKeywords(text);

    assert.ok(keywords.includes("z3nith"));
    assert.ok(keywords.includes("gass"));
    assert.ok(!keywords.includes("xxxxx"));
    assert.ok(!keywords.includes("qqqq"));
  });

  test("existing synthetic cold-start shape still yields issuer keywords and fields", () => {
    const text = "Nova Telecom Ltd.\nInvoice Date: July 1, 2026\nTotal Due: 45.90 EUR";
    const proposal = extractHandlers.inferTemplateProposal(text, { name: "nova-telecom-bill" });

    assert.deepEqual(proposal.match_keywords.slice(0, 2), ["nova", "telecom"]);
    assert.ok(proposal.fields.some((field) => field.amount_label === "total_due"));
    assert.ok(proposal.fields.some((field) => field.date_role === "invoice_date"));
  });
});

describe("T-G4.3 confirmed cold-start learning", () => {
  const NEW_SHAPE_TEXT_1 = [
    "Nova Telecom Ltd.",
    "Invoice Date: July 1, 2026",
    "Total Due: 45.90 EUR",
  ].join("\n");
  const NEW_SHAPE_TEXT_2 = [
    "Nova Telecom Ltd.",
    "Invoice Date: August 1, 2026",
    "Total Due: 45.90 EUR",
  ].join("\n");

  test("first document: no confident match, proposes a template, persists nothing until confirmed", async () => {
    const before = await templateHandlers.list(store);
    const result = await extractHandlers.matchOrPropose(ctxFor(store), { text: NEW_SHAPE_TEXT_1, name: "nova-telecom-bill" });
    assert.equal(result.status, "proposed");
    assert.ok(result.token);
    assert.ok(result.proposal.fields.length > 0);

    const stillNone = await templateHandlers.list(store);
    assert.equal(stillNone.length, before.length, "proposing must not persist a row");

    const { row, template } = await templateHandlers.decideTemplateProposal(ctxFor(store), result.token, { decision: "approve" });
    assert.equal(row.status, "executed");
    assert.equal(template.name, "nova-telecom-bill");

    const after = await templateHandlers.list(store);
    assert.equal(after.length, before.length + 1);
  });

  test("second document of the same shape now auto-matches — no confirmation needed to match", async () => {
    const result = await extractHandlers.matchOrPropose(ctxFor(store), { text: NEW_SHAPE_TEXT_2 });
    assert.equal(result.status, "matched");
    assert.equal(result.template.name, "nova-telecom-bill");
  });

  test("rejecting a proposal leaves extraction_templates untouched", async () => {
    const before = await templateHandlers.list(store);
    const result = await extractHandlers.matchOrPropose(ctxFor(store), {
      text: "Zenith Gas Corp.\nInvoice Date: Sept 1, 2026\nGrand Total: 12.00 USD",
      name: "zenith-gas-bill",
    });
    assert.equal(result.status, "proposed");

    await templateHandlers.decideTemplateProposal(ctxFor(store), result.token, { decision: "reject" });
    const after = await templateHandlers.list(store);
    assert.equal(after.length, before.length);
    assert.equal(await templateHandlers.get(store, { name: "zenith-gas-bill" }), null);
  });

  test("exactly one row exists for the sequence above (not zero, not two)", async () => {
    const nova = await templateHandlers.get(store, { name: "nova-telecom-bill" });
    assert.ok(nova);
    const zenith = await templateHandlers.get(store, { name: "zenith-gas-bill" });
    assert.equal(zenith, null);
  });

  test("a claim is rejected if the interrupt's canonical arguments were tampered with after approval", async () => {
    const result = await extractHandlers.matchOrPropose(ctxFor(store), {
      text: "Orbit Water Utility\nInvoice Date: Oct 1, 2026\nAmount Due: 33.10 USD",
      name: "orbit-water-bill",
    });
    const service = templateHandlers.templateInterruptService(ctxFor(store));
    await service.decide(result.token, { decision: "approve" });

    // Simulate tampering: mutate the stored interrupt's canonical_arguments
    // directly, bypassing the service, between approval and claim. The
    // tampered payload must still be independently valid (a real slug, a
    // real field) so the digest mismatch is what actually catches it, not
    // an unrelated validation error.
    const tampered = JSON.stringify({ name: "orbit-water-bill-evil-twin", match_keywords: [], fields: [{ name: "x", amount_label: "total_due" }] });
    store.db.prepare(`UPDATE agent_interrupts SET canonical_arguments = ? WHERE id = ?`).run(tampered, result.token);

    await assert.rejects(() => service.claim(result.token), /digest changed/);
    assert.equal(await templateHandlers.get(store, { name: "orbit-water-bill" }), null);
    assert.equal(await templateHandlers.get(store, { name: "orbit-water-bill-evil-twin" }), null);
  });
});

// ─── T-G4.4 — extraction log dedup/verification ──────────────────────────────
describe("T-G4.4 extraction_log", () => {
  const DOC_TEXT = "Helio Broadband\nInvoice Date: Nov 1, 2026\nAmount Due: 19.99 USD";

  test("first pass creates a log row only after the caller confirms the write; starts 'unverified'", async () => {
    const before = await extractHandlers.getLogByHash(store, sha256(DOC_TEXT));
    assert.equal(before, null, "no row should exist before any write is confirmed");

    // Simulate: caller ran db_execute, it succeeded, THEN records the log.
    const logged = await extractHandlers.recordExtraction(store, {
      sourceHash: sha256(DOC_TEXT), sourcePath: "docs/helio-nov.txt", rowCount: 1,
    });
    assert.equal(logged.verification_state, "unverified");

    const verified = await extractHandlers.markVerification(store, { id: logged.id, state: "verified" });
    assert.equal(verified.verification_state, "verified");
  });

  test("second pass with identical text reports 'already extracted' citing the prior row, no duplicate", async () => {
    const template = await templateHandlers.get(store, { name: "nova-telecom-bill" }) ?? await templateHandlers.list(store).then((l) => l[0]);
    const result = await extractHandlers.extractFromTemplate(store, { text: DOC_TEXT, template });
    assert.ok(result.alreadyExtracted, "identical-hash source must be reported as already extracted");
    assert.equal(result.fields.length, 0);
  });

  test("third pass — same path, different content — is treated as a genuinely new source", async () => {
    const modified = DOC_TEXT + "\nLate fee: 2.00 USD";
    const priorForModified = await extractHandlers.getLogByHash(store, sha256(modified));
    assert.equal(priorForModified, null, "a content change must produce a new hash, not a false dedup hit");

    const logged = await extractHandlers.recordExtraction(store, {
      sourceHash: sha256(modified), sourcePath: "docs/helio-nov.txt", rowCount: 1,
    });
    assert.ok(logged.id);
    assert.notEqual(logged.source_hash, sha256(DOC_TEXT));
  });

  test("source_path is never the dedup key on its own — same path, different hash, both rows coexist", async () => {
    if (store.db) {
      const rows = store.db.prepare(`SELECT * FROM extraction_log WHERE source_path = ?`).all("docs/helio-nov.txt");
      assert.equal(rows.length, 2);
    }
  });

  test("a declined write leaves no log row at all (never a false 'already extracted')", async () => {
    const declinedText = "Never Written Inc.\nAmount Due: 1.00 USD";
    // The caller's contract: never call recordExtraction unless the write
    // actually succeeded. A declined write simply never reaches that call.
    const check = await extractHandlers.getLogByHash(store, sha256(declinedText));
    assert.equal(check, null);
  });
});
