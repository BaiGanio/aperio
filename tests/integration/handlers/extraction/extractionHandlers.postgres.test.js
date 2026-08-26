// tests/integration/handlers/extraction/extractionHandlers.postgres.test.js
// Document Intelligence WS3 (issue #250) — Postgres half of T-G4. Same
// convention as postgres-vec-meta.test.js: provisions its own throwaway
// database off APERIO_E2E_POSTGRES_URL, runs migrations via PostgresStore.init(),
// and drops the database in after().
//
// extractionHandlers.test.js already covers the full CRUD/matching/cold-start/
// dedup surface against SQLite (26 tests) and wsG5-2-e2e.postgres.test.js
// already proves the single-template happy path against Postgres end to end.
// This file targets the specific store.pool code paths those two don't reach:
// the Postgres unique-violation (23505) error mapping (a different code path
// than SQLite's regex-matched error message), multi-template ranking/ambiguous
// classification, and the extraction_log/cold-start edge cases that involve
// raw SQL against agent_interrupts (jsonb, not SQLite's json_set/TEXT).

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import pg from "pg";

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const PG_URL = process.env.APERIO_E2E_POSTGRES_URL;
const PROBE_DB = `aperio_ws3_g4_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

describe("T-G4 (Postgres) extraction handlers", { skip: PG_URL ? false : "APERIO_E2E_POSTGRES_URL not set" }, () => {
  let admin, store, oldUrl;
  let templateHandlers, matchHandlers, extractHandlers;

  function ctxFor(store) { return { store }; }

  before(async () => {
    admin = new pg.Pool({ connectionString: PG_URL });
    await admin.query(`CREATE DATABASE ${PROBE_DB}`);

    const url = new URL(PG_URL);
    url.pathname = `/${PROBE_DB}`;
    oldUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url.toString();

    const { PostgresStore } = await import("../../../../db/postgres.js");
    store = await PostgresStore.init();

    templateHandlers = await import("../../../../lib/handlers/extraction/templateHandlers.js");
    matchHandlers = await import("../../../../lib/handlers/extraction/matchHandlers.js");
    extractHandlers = await import("../../../../lib/handlers/extraction/extractHandlers.js");
  });

  after(async () => {
    await store?.pool?.end?.();
    if (oldUrl) process.env.DATABASE_URL = oldUrl; else delete process.env.DATABASE_URL;
    if (admin) {
      await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [PROBE_DB]);
      await admin.query(`DROP DATABASE IF EXISTS ${PROBE_DB}`);
      await admin.end();
    }
  });

  // ─── CRUD + Postgres-specific unique-violation mapping ─────────────────────
  describe("T-G4.1 templateHandlers CRUD (store.pool)", () => {
    test("create/get/list roundtrip via RETURNING *, JSONB columns come back as real arrays/objects", async () => {
      const row = await templateHandlers.create(store, {
        name: "pg-crud-basic",
        match_keywords: ["acme", "utilities"],
        fields: [{ name: "total", amount_label: "total_due" }],
      });
      assert.ok(row.id);
      assert.deepEqual(row.match_keywords, ["acme", "utilities"]);
      assert.deepEqual(row.fields, [{ name: "total", amount_label: "total_due" }]);

      const fetched = await templateHandlers.get(store, { id: row.id });
      assert.deepEqual(fetched.fields, row.fields);

      const list = await templateHandlers.list(store);
      assert.ok(list.some((t) => t.name === "pg-crud-basic"));
    });

    test("update via RETURNING * bumps updated_at and preserves created_at", async () => {
      const created = await templateHandlers.create(store, {
        name: "pg-crud-update",
        match_keywords: ["x"],
        fields: [{ name: "total", amount_label: "total_due" }],
      });
      await new Promise((r) => setTimeout(r, 5));
      const updated = await templateHandlers.update(store, { id: created.id, confidence: 0.5 });
      assert.equal(updated.created_at.getTime?.() ?? updated.created_at, created.created_at.getTime?.() ?? created.created_at);
      assert.notEqual(updated.updated_at, created.updated_at);
      assert.equal(updated.confidence, 0.5);
    });

    test("duplicate name on create is rejected as a clean userFacing error via Postgres error code 23505 (not SQLite's regex path)", async () => {
      await templateHandlers.create(store, { name: "pg-crud-dup", fields: [{ name: "x", amount_label: "total_due" }] });
      await assert.rejects(
        () => templateHandlers.create(store, { name: "pg-crud-dup", fields: [{ name: "y", amount_label: "grand_total" }] }),
        (err) => err.userFacing === true && /already exists/.test(err.message)
      );
    });

    test("duplicate name on rename (update) is rejected the same way", async () => {
      const a = await templateHandlers.create(store, { name: "pg-rename-a", fields: [{ name: "x", amount_label: "total_due" }] });
      await templateHandlers.create(store, { name: "pg-rename-b", fields: [{ name: "x", amount_label: "total_due" }] });
      await assert.rejects(
        () => templateHandlers.update(store, { id: a.id, name: "pg-rename-b" }),
        (err) => err.userFacing === true && /already exists/.test(err.message)
      );
    });

    test("remove via rowCount reports true/false correctly", async () => {
      const row = await templateHandlers.create(store, { name: "pg-crud-delete-me", fields: [{ name: "x", amount_label: "total_due" }] });
      assert.equal(await templateHandlers.remove(store, { id: row.id }), true);
      assert.equal(await templateHandlers.remove(store, { id: row.id }), false);
      assert.equal(await templateHandlers.get(store, { id: row.id }), null);
    });
  });

  // ─── Multi-template ranking / ambiguous classification ─────────────────────
  describe("T-G4.2 matching across multiple Postgres-stored templates", () => {
    const BILL_TEXT = [
      "Acme Power & Water Co.",
      "Invoice Date: June 3, 2026",
      "Amount Due: 260.50 BGN",
    ].join("\n");

    before(async () => {
      await templateHandlers.create(store, {
        name: "pg-acme-utility-bill",
        match_keywords: matchHandlers.significantWords(BILL_TEXT),
        fields: [{ name: "total", amount_label: "amount_due" }],
      });
      await templateHandlers.create(store, {
        name: "pg-narrow-near-miss",
        match_keywords: ["acme", "power", "gas"],
        fields: [{ name: "total", amount_label: "grand_total" }],
      });
    });

    test("matchTemplates ranks the correct template first and rejects substring false positives", async () => {
      const ranked = await matchHandlers.matchTemplates(store, { text: BILL_TEXT });
      assert.equal(ranked[0].template.name, "pg-acme-utility-bill");

      const vegas = await matchHandlers.matchTemplates(store, { text: "A trip to Las Vegas, no acme or power here." });
      const narrow = vegas.find((r) => r.template.name === "pg-narrow-near-miss");
      assert.ok(!narrow.matchedKeywords.includes("gas"), '"gas" must not match inside "Vegas" when templates are stored in Postgres');
      assert.ok(narrow.matchedKeywords.includes("acme"));
    });

    test("extractFromTemplate resolves a labeled field and updates the template's rolling confidence via store.pool", async () => {
      const template = await templateHandlers.get(store, { name: "pg-acme-utility-bill" });
      const result = await extractHandlers.extractFromTemplate(store, { text: BILL_TEXT, template });
      const total = result.fields.find((f) => f.name === "total");
      assert.equal(total.value, 260.5);
      assert.equal(total.provenance, "label");

      const after = await templateHandlers.get(store, { id: template.id });
      assert.notEqual(after.confidence, 0, "confidence must move off the create-time 0 default after a real extraction");
    });
  });

  // ─── Cold-start: reject persists nothing + digest-tamper rejection (jsonb) ──
  describe("T-G4.3 confirmed cold-start learning (agent_interrupts as JSONB)", () => {
    test("rejecting a proposal leaves extraction_templates untouched", async () => {
      const before = await templateHandlers.list(store);
      const result = await extractHandlers.matchOrPropose(ctxFor(store), {
        text: "Zenith Gas Corp.\nInvoice Date: Sept 1, 2026\nGrand Total: 12.00 USD",
        name: "pg-zenith-gas-bill",
      });
      assert.equal(result.status, "proposed");

      await templateHandlers.decideTemplateProposal(ctxFor(store), result.token, { decision: "reject" });
      const after = await templateHandlers.list(store);
      assert.equal(after.length, before.length);
      assert.equal(await templateHandlers.get(store, { name: "pg-zenith-gas-bill" }), null);
    });

    test("a claim is rejected if the interrupt's canonical_arguments (jsonb) were tampered with after approval", async () => {
      const result = await extractHandlers.matchOrPropose(ctxFor(store), {
        text: "Orbit Water Utility\nInvoice Date: Oct 1, 2026\nAmount Due: 33.10 USD",
        name: "pg-orbit-water-bill",
      });
      const service = templateHandlers.templateInterruptService(ctxFor(store));
      await service.decide(result.token, { decision: "approve" });

      // Postgres stores canonical_arguments as native jsonb (vs. SQLite's
      // CHECK(json_valid(...)) TEXT column) — the tamper path must use jsonb_set,
      // not SQLite's json_set, to prove the digest check has teeth on this backend too.
      const tampered = JSON.stringify({ name: "pg-orbit-water-bill-evil-twin", match_keywords: [], fields: [{ name: "x", amount_label: "total_due" }] });
      await store.pool.query(
        `UPDATE agent_interrupts SET canonical_arguments = $1::jsonb WHERE id = $2`,
        [tampered, result.token]
      );

      await assert.rejects(() => service.claim(result.token), /digest changed/);
      assert.equal(await templateHandlers.get(store, { name: "pg-orbit-water-bill" }), null);
      assert.equal(await templateHandlers.get(store, { name: "pg-orbit-water-bill-evil-twin" }), null);
    });
  });

  // ─── extraction_log dedup edge cases ────────────────────────────────────────
  describe("T-G4.4 extraction_log (store.pool)", () => {
    const DOC_TEXT = "Helio Broadband\nInvoice Date: Nov 1, 2026\nAmount Due: 19.99 USD";

    test("first pass creates a log row only after confirmation; verification round-trips via RETURNING *", async () => {
      const logged = await extractHandlers.recordExtraction(store, {
        sourceHash: sha256(DOC_TEXT), sourcePath: "docs/helio-nov.txt", rowCount: 1,
      });
      assert.equal(logged.verification_state, "unverified");
      const verified = await extractHandlers.markVerification(store, { id: logged.id, state: "verified" });
      assert.equal(verified.verification_state, "verified");
    });

    test("duplicate source_hash is rejected via Postgres 23505, not silently double-inserted", async () => {
      await assert.rejects(
        () => extractHandlers.recordExtraction(store, { sourceHash: sha256(DOC_TEXT), sourcePath: "docs/helio-nov.txt", rowCount: 1 }),
        (err) => err.userFacing === true && /already extracted/.test(err.message)
      );
    });

    test("source_path is never the dedup key on its own — same path, different hash, both rows coexist", async () => {
      const modified = DOC_TEXT + "\nLate fee: 2.00 USD";
      const logged = await extractHandlers.recordExtraction(store, {
        sourceHash: sha256(modified), sourcePath: "docs/helio-nov.txt", rowCount: 1,
      });
      assert.ok(logged.id);
      const { rows } = await store.pool.query(`SELECT * FROM extraction_log WHERE source_path = $1`, ["docs/helio-nov.txt"]);
      assert.equal(rows.length, 2);
    });

    test("a declined write leaves no log row at all", async () => {
      const check = await extractHandlers.getLogByHash(store, sha256("Never Written Inc.\nAmount Due: 1.00 USD"));
      assert.equal(check, null);
    });

    test("ON DELETE SET NULL: deleting the referenced template nulls out extraction_log.template_id", async () => {
      const template = await templateHandlers.create(store, { name: "pg-fk-test", fields: [{ name: "x", amount_label: "total_due" }] });
      const logged = await extractHandlers.recordExtraction(store, {
        sourceHash: sha256("fk-test-doc"), templateId: template.id, rowCount: 1,
      });
      await templateHandlers.remove(store, { id: template.id });
      const { rows } = await store.pool.query(`SELECT template_id FROM extraction_log WHERE id = $1`, [logged.id]);
      assert.equal(rows[0].template_id, null);
    });
  });
});
