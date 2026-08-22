// tests/integration/handlers/extraction/wsG5-2-e2e.postgres.test.js
// Document Intelligence WS3 (issue #250) — Postgres half of T-G5.2. Same full
// sample-bill chain as wsG5-2-e2e.test.js (doc text -> extraction_template_match
// -> propose -> confirm -> extraction_apply -> db_execute propose/confirm ->
// generate_xlsx), checked against the same household-gen oracle, but with
// Aperio's OWN store backed by a real Postgres (extraction_templates/
// extraction_log/agent_interrupts all go through store.pool, not store.db) —
// the one thing the epic's evidence log flagged as written but never
// live-verified. The self-provisioned "extraction" write destination (WS1)
// is a SQLite file regardless of the main store's backend by design
// (lib/db-connect/extraction.js), so that part of the chain is unchanged;
// what's new here is exercising extraction_templates/extraction_log/
// agent_interrupts CRUD against real Postgres SQL.
//
// Runs only when APERIO_E2E_POSTGRES_URL is set (same opt-in knob
// tests/integration/db/contract/backends.js and postgres-vec-meta.test.js
// use) AND the household corpus is present (same skip-gracefully idiom as
// tests/unit/docgraph/facts/june-gate.test.js) — the corpus lives outside
// the repo.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import ExcelJS from "exceljs";

const PG_URL = process.env.APERIO_E2E_POSTGRES_URL;
const CORPUS_ROOT = process.env.APERIO_HOUSEHOLD_CORPUS ?? "/Users/lk/Projects/household";
const BILL_PATH = join(CORPUS_ROOT, "2026", "June", "heating-bill-15-jun.txt");
const corpusPresent = existsSync(BILL_PATH);
const PROBE_DB = `aperio_ws3_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

const skip = !PG_URL ? "APERIO_E2E_POSTGRES_URL not set"
  : !corpusPresent ? `household corpus not present at ${CORPUS_ROOT}`
  : false;

// Oracle values for this exact document (tests/fixtures/household-gen/ground-truth.json,
// "2026-06-utilities-heating"): amount_bgn 64.8, document_date 2026-06-15,
// due_date 2026-06-30, service_period 2026-05 (01.05.2026 - 31.05.2026).
const ORACLE = {
  amount: 64.8, currency: "BGN",
  invoiceDate: "2026-06-15", dueDate: "2026-06-30",
  periodStart: "2026-05-01", periodEnd: "2026-05-31",
};

describe("T-G5.2 (Postgres) — sample bill end to end", { skip }, () => {
  let admin, probeUrl;
  let store, oldUrl;
  let templateHandlers, extractHandlers;
  let registeredExtraction, registeredDatabase;
  let extractionDbPath, deleteExtractionFile;
  let generatedXlsxPaths = [];
  let insertToken;

  function fakeServer(registry) {
    return { registerTool: (name, config, handler) => registry.set(name, { config, handler }) };
  }
  const text = (r) => r.content[0].text;
  const json = (r) => JSON.parse(text(r));

  before(async () => {
    admin = new pg.Pool({ connectionString: PG_URL });
    await admin.query(`CREATE DATABASE ${PROBE_DB}`);

    const url = new URL(PG_URL);
    url.pathname = `/${PROBE_DB}`;
    probeUrl = url.toString();

    oldUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = probeUrl;

    const { PostgresStore } = await import("../../../../db/postgres.js");
    store = await PostgresStore.init();

    templateHandlers = await import("../../../../lib/handlers/extraction/templateHandlers.js");
    extractHandlers = await import("../../../../lib/handlers/extraction/extractHandlers.js");
    ({ extractionDbPath, deleteExtractionFile } = await import("../../../../lib/db-connect/extraction.js"));

    registeredExtraction = new Map();
    const { register: registerExtraction } = await import("../../../../mcp/tools/extraction.js");
    registerExtraction(fakeServer(registeredExtraction), { store });

    registeredDatabase = new Map();
    const { register: registerDatabase } = await import("../../../../mcp/tools/database.js");
    registerDatabase(fakeServer(registeredDatabase), { store });
  });

  after(async () => {
    if (store) { try { await deleteExtractionFile(extractionDbPath(store)); } catch { /* already gone */ } }
    for (const p of generatedXlsxPaths) { try { rmSync(p); } catch { /* already gone */ } }
    await store?.pool?.end?.();
    if (oldUrl) process.env.DATABASE_URL = oldUrl; else delete process.env.DATABASE_URL;

    if (admin) {
      await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [PROBE_DB]);
      await admin.query(`DROP DATABASE IF EXISTS ${PROBE_DB}`);
      await admin.end();
    }
  });

  const BILL_TEXT = readFileSync(corpusPresent ? BILL_PATH : "/dev/null", "utf8");

  test("extraction_template_match reports no confident match on a clean profile", async () => {
    const { handler } = registeredExtraction.get("extraction_template_match");
    const out = json(await handler({ text: BILL_TEXT }));
    assert.equal(out.status, "none");
  });

  let proposalToken;
  test("extraction_template_propose proposes a template inferred from the bill's own evidence, saves nothing yet", async () => {
    const { handler } = registeredExtraction.get("extraction_template_propose");
    const out = await handler({ text: BILL_TEXT, name: "bg-central-heating-bill" });
    assert.match(text(out), /pending your confirmation/);
    proposalToken = text(out).match(/Token: (\S+)/)[1];

    const templatesBefore = json(await registeredExtraction.get("extraction_template_list").handler({}));
    assert.deepEqual(templatesBefore.templates, []);
  });

  let templateRow;
  test("confirming the proposal genuinely exercises the interrupt (not bypassed) and saves the template", async () => {
    const pendingBefore = await store.getAgentInterrupt(proposalToken);
    assert.equal(pendingBefore.status, "pending");

    const { handler } = registeredExtraction.get("extraction_template_propose");
    const out = json(await handler({ confirmation_token: proposalToken }));
    assert.equal(out.status, "saved");
    templateRow = out.template;

    const decided = await store.getAgentInterrupt(proposalToken);
    assert.equal(decided.status, "executed", "interrupt must reach executed, not be bypassed");

    const list = json(await registeredExtraction.get("extraction_template_list").handler({}));
    assert.equal(list.templates.length, 1);
  });

  test("add a field with no evidence in this document, to prove 'missing' is reported honestly", async () => {
    const withExtra = await templateHandlers.update(store, {
      id: templateRow.id,
      fields: [...templateRow.fields, { name: "payment_date", date_role: "payment_date" }],
    });
    assert.equal(withExtra.fields.length, templateRow.fields.length + 1);
    templateRow = withExtra;
  });

  let applyResult;
  test("extraction_apply resolves the bill's real fields at 'label' provenance and the added field as 'missing', never fabricated", async () => {
    const { handler } = registeredExtraction.get("extraction_apply");
    applyResult = json(await handler({ text: BILL_TEXT, template_name: "bg-central-heating-bill" }));
    assert.equal(applyResult.template, "bg-central-heating-bill");
    assert.ok(applyResult.sourceHash);

    const byName = Object.fromEntries(applyResult.fields.map((f) => [f.name, f]));
    assert.equal(byName.amount_due.value, ORACLE.amount);
    assert.equal(byName.amount_due.provenance, "label");
    assert.equal(byName.invoice_date.value, ORACLE.invoiceDate);
    assert.equal(byName.due_date.value, ORACLE.dueDate);
    assert.equal(byName.service_period_start.value, ORACLE.periodStart);
    assert.equal(byName.service_period_end.value, ORACLE.periodEnd);

    assert.equal(byName.payment_date.provenance, "missing");
    assert.equal(byName.payment_date.value, null, "an unresolved field must be null, never a fabricated/zero value");
  });

  test("db_execute CREATE TABLE + INSERT — confirmation gate genuinely exercised — matches the oracle exactly", async () => {
    const { handler: execute } = registeredDatabase.get("db_execute");
    const { handler: query } = registeredDatabase.get("db_query");

    const createPropose = await execute({
      connection: "extraction",
      sql: `CREATE TABLE document_extractions (
        id INTEGER PRIMARY KEY, source_hash TEXT UNIQUE, category TEXT, provider TEXT,
        invoice_date TEXT, due_date TEXT, service_period_start TEXT, service_period_end TEXT,
        payment_date TEXT, amount REAL, currency TEXT
      )`,
    });
    const createToken = text(createPropose).match(/Token: (\S+)/)[1];
    const createCommit = await execute({ confirmation_token: createToken });
    assert.match(text(createCommit), /✅ Executed/);

    const byName = Object.fromEntries(applyResult.fields.map((f) => [f.name, f]));
    const insertPropose = await execute({
      connection: "extraction",
      sql: `INSERT INTO document_extractions
        (source_hash, category, provider, invoice_date, due_date, service_period_start, service_period_end, payment_date, amount, currency)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        applyResult.sourceHash, "Utilities", "ТоплоСофия ЕАД",
        byName.invoice_date.value, byName.due_date.value,
        byName.service_period_start.value, byName.service_period_end.value,
        byName.payment_date.value, // must land as NULL, not 0 or ""
        byName.amount_due.value, byName.amount_due.currency,
      ],
    });
    const insertTokenBefore = await store.getAgentInterrupt(text(insertPropose).match(/Token: (\S+)/)[1]);
    assert.equal(insertTokenBefore.status, "pending", "write must not have happened before confirmation");
    insertToken = insertTokenBefore.id;
    const insertCommit = await execute({ confirmation_token: insertToken });
    assert.match(text(insertCommit), /✅ Executed/);
    assert.equal((await store.getAgentInterrupt(insertToken)).status, "executed");

    const rows = json(await query({ connection: "extraction", sql: "SELECT * FROM document_extractions" })).rows;
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.amount, ORACLE.amount);
    assert.equal(row.currency, ORACLE.currency);
    assert.equal(row.invoice_date, ORACLE.invoiceDate);
    assert.equal(row.due_date, ORACLE.dueDate);
    assert.equal(row.service_period_start, ORACLE.periodStart);
    assert.equal(row.service_period_end, ORACLE.periodEnd);
    assert.equal(row.payment_date, null, "missing field must be NULL in the DB, never silently zero/blank-string-filled as if resolved");
  });

  test("extraction_log_record — the exposed tool — records the write only now that it's confirmed", async () => {
    const { handler } = registeredExtraction.get("extraction_log_record");
    const out = json(await handler({
      source_hash: applyResult.sourceHash, source_path: "2026/June/heating-bill-15-jun.txt",
      db_execute_token: insertToken, template_name: "bg-central-heating-bill", row_count: 1,
    }));
    assert.equal(out.status, "recorded");
    assert.equal(out.log.verification_state, "unverified");

    const verified = await extractHandlers.markVerification(store, { id: out.log.id, state: "verified" });
    assert.equal(verified.verification_state, "verified");
  });

  test("extraction_log_check now reports 'already extracted'", async () => {
    const { handler } = registeredExtraction.get("extraction_log_check");
    const out = json(await handler({ source_hash: applyResult.sourceHash }));
    assert.ok(out.alreadyExtracted);
    assert.equal(out.alreadyExtracted.verification_state, "verified");
  });

  test("a second extraction_apply run against the identical source is deduped, not silently re-run", async () => {
    const { handler } = registeredExtraction.get("extraction_apply");
    const out = json(await handler({ text: BILL_TEXT, template_name: "bg-central-heating-bill" }));
    assert.ok(out.alreadyExtracted);
    assert.equal(out.fields, undefined);
  });

  test("generate_xlsx export matches the same oracle values — header names match field names", async () => {
    const { generateXlsxHandler } = await import("../../../../mcp/tools/files/generate.js");
    const byName = Object.fromEntries(applyResult.fields.map((f) => [f.name, f]));
    const headers = ["source_hash", "category", "invoice_date", "due_date", "service_period_start", "service_period_end", "payment_date", "amount", "currency"];
    const row = [
      applyResult.sourceHash, "Utilities",
      byName.invoice_date.value, byName.due_date.value,
      byName.service_period_start.value, byName.service_period_end.value,
      byName.payment_date.value,
      byName.amount_due.value, byName.amount_due.currency,
    ];

    const result = await generateXlsxHandler({
      filename: "wsG5-2-heating-bill-postgres.xlsx",
      sheets: [{ name: "extraction", headers, rows: [row] }],
    });
    const meta = JSON.parse(text(result).replace("APERIO_FILE:", ""));
    generatedXlsxPaths.push(meta.path);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(meta.path);
    const ws = wb.getWorksheet("extraction");
    const headerRow = ws.getRow(1).values.slice(1);
    assert.deepEqual(headerRow, headers);

    const dataRow = ws.getRow(2).values.slice(1);
    assert.equal(dataRow[headers.indexOf("amount")], ORACLE.amount);
    assert.equal(dataRow[headers.indexOf("currency")], ORACLE.currency);
    assert.equal(dataRow[headers.indexOf("invoice_date")], ORACLE.invoiceDate);
    assert.equal(dataRow[headers.indexOf("due_date")], ORACLE.dueDate);
    const paymentDateCell = dataRow[headers.indexOf("payment_date")];
    assert.ok(paymentDateCell === null || paymentDateCell === undefined, "missing field must be blank in the workbook too, not zero-filled");
    assert.notEqual(paymentDateCell, 0);
    assert.notEqual(paymentDateCell, "");
  });
});

// Registers one diagnostic-only test when skipped, mirroring
// tests/integration/db/contract/backends.js's postgresSkipNotice.
if (skip) {
  test("T-G5.2 (Postgres) skipped", (t) => { t.diagnostic(skip); });
}
