// tests/integration/mcp/tools/extraction.test.js
// Document Intelligence WS3 (issue #250), T-G5.1 — mcp/tools/extraction.js's
// zod schemas and end-to-end tool wiring against a real in-memory SqliteStore
// (same convention as tests/integration/handlers/extraction/extractionHandlers.test.js).
// Does not boot a real McpServer — captures registerTool() calls the same way
// this file's sibling tests exercise handlers directly, but additionally
// validates the exact zod schemas register() hands the server.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";

let store, oldPath;
let registerExtraction, registerDatabase;
const registered = new Map();
const db = new Map(); // database.js's tools, kept separate for clarity

// Deterministic stand-in for the real LLM completion call — never a live
// model in tests. Returns a canned field so extraction_apply's fallback path
// is genuinely exercised, not just skipped.
const stubComplete = async (messages, _opts) => {
  const prompt = messages[0]?.content ?? "";
  if (prompt.includes("due_date")) return JSON.stringify({ due_date: "2026-07-15" });
  return "{}";
};

function fakeServer(registry) {
  return {
    registerTool(name, config, handler) {
      registry.set(name, { config, handler });
    },
  };
}

before(async () => {
  oldPath = process.env.SQLITE_PATH;
  process.env.SQLITE_PATH = ":memory:";
  const { SqliteStore } = await import("../../../../db/sqlite.js");
  store = await SqliteStore.init();

  ({ register: registerExtraction } = await import("../../../../mcp/tools/extraction.js"));
  registerExtraction(fakeServer(registered), { store }, { completeFn: stubComplete });

  ({ register: registerDatabase } = await import("../../../../mcp/tools/database.js"));
  registerDatabase(fakeServer(db), { store });
});

after(async () => {
  if (oldPath) process.env.SQLITE_PATH = oldPath; else delete process.env.SQLITE_PATH;
  // This suite now performs real db_execute writes against the self-
  // provisioned "extraction" connection (AGENTS.md: no stray state).
  if (store) {
    const { extractionDbPath, deleteExtractionFile } = await import("../../../../lib/db-connect/extraction.js");
    try { await deleteExtractionFile(extractionDbPath(store)); } catch { /* already gone */ }
  }
  store?.close?.();
});

const text = (r) => r.content[0].text;
const json = (r) => JSON.parse(text(r));

// ─── T-G5.1 — schema validation ──────────────────────────────────────────────
describe("T-G5.1 tool registration and schemas", () => {
  test("all eight tools are registered", () => {
    assert.deepEqual(
      [...registered.keys()].sort(),
      [
        "extraction_apply", "extraction_log_check", "extraction_log_record",
        "extraction_template_delete", "extraction_template_get", "extraction_template_list",
        "extraction_template_match", "extraction_template_propose",
      ]
    );
  });

  const REPRESENTATIVE = {
    extraction_template_list: {},
    extraction_template_get: { name: "some-template" },
    extraction_template_match: { text: "Invoice Date: June 1, 2026\nAmount Due: 10.00 USD" },
    extraction_template_propose: { text: "Invoice Date: June 1, 2026\nAmount Due: 10.00 USD", name: "some-template" },
    extraction_template_delete: { id: 1 },
    extraction_apply: { text: "Invoice Date: June 1, 2026\nAmount Due: 10.00 USD", template_name: "some-template" },
    extraction_log_check: { source_hash: "abc123" },
    extraction_log_record: { source_hash: "abc123", db_execute_token: "db_abc123", template_name: "some-template", row_count: 1 },
  };

  for (const [name, input] of Object.entries(REPRESENTATIVE)) {
    test(`${name}: representative input parses cleanly`, () => {
      const { config } = registered.get(name);
      const result = config.inputSchema.safeParse(input);
      assert.equal(result.success, true, result.error?.message);
    });

    // extraction_template_list takes no fields at all — .passthrough() means
    // any extra key is allowed through untyped, so there is no "wrong type"
    // to send against an empty schema.
    if (name === "extraction_template_list") continue;

    test(`${name}: rejects a structurally invalid input, not a crash`, () => {
      const { config } = registered.get(name);
      // Every field this suite defines is a string/number; an array in place
      // of the first key is structurally wrong for every schema tested here.
      const [firstKey] = Object.keys(input);
      const bad = { [firstKey]: [1, 2, 3] };
      const result = config.inputSchema.safeParse(bad);
      assert.equal(result.success, false);
    });
  }

  test("a handler called MCP-style — (args, extra) — still receives and uses the real args, not extra", async () => {
    // The MCP SDK's real ToolCallback signature is (args, extra: RequestHandlerExtra)
    // — two arguments. safeHandler's fn closures each declare a single parameter,
    // so this asserts the wrapper genuinely passes args through as the ONLY
    // argument fn sees, rather than relying on JS silently dropping a second
    // positional argument (which would break the moment any fn's arity changed).
    const { handler } = registered.get("extraction_template_match");
    const fakeExtra = { requestId: "req-1", signal: new AbortController().signal, sendNotification: async () => {} };
    const out = json(await handler({ text: "Invoice Date: June 1, 2026\nAmount Due: 10.00 USD" }, fakeExtra));
    assert.equal(out.status, "none"); // real match ran — no "text is required" error
  });

  test("extraction_apply: optional template_id/template_name may both be omitted", () => {
    const { config } = registered.get("extraction_apply");
    const result = config.inputSchema.safeParse({ text: "some text" });
    assert.equal(result.success, true, result.error?.message);
  });

  test("near-miss key (document_text) passes through via .passthrough(), handled by pickText", () => {
    const { config } = registered.get("extraction_template_match");
    const result = config.inputSchema.safeParse({ document_text: "some text" });
    assert.equal(result.success, true);
  });
});

// ─── T-G5.1/T-G5.2 — end-to-end tool chain against a real store ─────────────
describe("extraction MCP tools — end-to-end chain", () => {
  const BILL = "Meridian Fiber Ltd.\nInvoice Date: July 1, 2026\nAmount Due: 15.50 USD";

  test("list starts empty", async () => {
    const { handler } = registered.get("extraction_template_list");
    const out = json(await handler({}));
    assert.deepEqual(out.templates, []);
  });

  test("get on a missing template returns a clean error, not a throw", async () => {
    const { handler } = registered.get("extraction_template_get");
    const out = await handler({ name: "nope" });
    assert.ok(out.isError);
    assert.match(text(out), /no template found/);
  });

  test("match on an empty store reports status 'none'", async () => {
    const { handler } = registered.get("extraction_template_match");
    const out = json(await handler({ text: BILL }));
    assert.equal(out.status, "none");
    assert.deepEqual(out.ranked, []);
  });

  let proposalToken;
  test("propose (no confirmation_token) creates a pending proposal, saves nothing yet", async () => {
    const { handler } = registered.get("extraction_template_propose");
    const out = await handler({ text: BILL, name: "meridian-fiber-bill" });
    assert.match(text(out), /pending your confirmation/);
    const m = text(out).match(/Token: (\S+)/);
    assert.ok(m, "response must include a confirmation token");
    proposalToken = m[1];

    const list = json(await registered.get("extraction_template_list").handler({}));
    assert.deepEqual(list.templates, []);
  });

  test("propose (with confirmation_token) commits the template", async () => {
    const { handler } = registered.get("extraction_template_propose");
    const out = json(await handler({ confirmation_token: proposalToken }));
    assert.equal(out.status, "saved");
    assert.equal(out.template.name, "meridian-fiber-bill");

    const list = json(await registered.get("extraction_template_list").handler({}));
    assert.equal(list.templates.length, 1);
  });

  test("a second propose for the same text now reports 'matched' instead of proposing a duplicate", async () => {
    const { handler } = registered.get("extraction_template_propose");
    const out = json(await handler({ text: BILL }));
    assert.equal(out.status, "matched");
    assert.equal(out.template, "meridian-fiber-bill");
  });

  let sourceHash;
  test("apply extracts fields against the confirmed template", async () => {
    const { handler } = registered.get("extraction_apply");
    const out = json(await handler({ text: BILL, template_name: "meridian-fiber-bill" }));
    assert.equal(out.template, "meridian-fiber-bill");
    assert.ok(out.sourceHash);
    sourceHash = out.sourceHash;
    const amountField = out.fields.find((f) => f.value === 15.5);
    assert.ok(amountField, "amount_due field must resolve");
    assert.equal(amountField.provenance, "label");
  });

  test("log_check finds nothing yet (extraction_log is only written after a confirmed db_execute write)", async () => {
    const { handler } = registered.get("extraction_log_check");
    const out = json(await handler({ source_hash: sourceHash }));
    assert.equal(out.alreadyExtracted, null);
  });

  test("a successful apply feeds the template's own rolling confidence, not just the per-extraction one", async () => {
    // The earlier "apply extracts fields" test already triggered one update,
    // so this template is no longer at its create-time 0 default — confirm
    // that, then prove the rolling average keeps reacting to new outcomes
    // (not just a one-time bump) using a worse extraction (missing the
    // invoice_date field this template also expects).
    const before = json(await registered.get("extraction_template_get").handler({ name: "meridian-fiber-bill" }));
    assert.ok(before.template.confidence > 0, "an earlier apply in this suite must already have moved it off the create-time 0 default");

    const { handler } = registered.get("extraction_apply");
    await handler({ text: "Meridian Fiber Ltd.\nAmount Due: 15.50 USD", template_name: "meridian-fiber-bill" });

    const after = json(await registered.get("extraction_template_get").handler({ name: "meridian-fiber-bill" }));
    assert.notEqual(after.template.confidence, before.template.confidence, "confidence must move again after a new, worse-outcome extraction — not freeze after the first update");
  });

  test("extraction_apply's LLM fallback is genuinely invoked for a field regex/label can't resolve", async () => {
    const templateHandlers = await import("../../../../lib/handlers/extraction/templateHandlers.js");
    const template = await templateHandlers.get(store, { name: "meridian-fiber-bill" });
    // due_date has no evidence anywhere in BILL — regex/label will leave it
    // unresolved, forcing the LLM-fallback path (stubComplete above).
    await templateHandlers.update(store, { id: template.id, fields: [...template.fields, { name: "due_date", date_role: "due_date" }] });

    const { handler } = registered.get("extraction_apply");
    const out = json(await handler({ text: BILL, template_name: "meridian-fiber-bill" }));
    const dueDate = out.fields.find((f) => f.name === "due_date");
    assert.equal(dueDate.provenance, "llm", "a field with no regex/label evidence must go through the LLM fallback, not report 'missing' outright");
    assert.equal(dueDate.value, "2026-07-15");
  });

  describe("log_record — db_execute_token verification (P1 fix)", () => {
    test("rejects a missing db_execute_token — refuses to trust an unverifiable claim", async () => {
      const { handler } = registered.get("extraction_log_record");
      const out = await handler({ source_hash: sourceHash, template_name: "meridian-fiber-bill" });
      assert.ok(out.isError);
      assert.match(text(out), /db_execute_token.*required/i);
    });

    test("rejects a token from a db_execute proposal that was never confirmed", async () => {
      const proposeRes = await db.get("db_execute").handler({
        connection: "extraction", sql: "CREATE TABLE t_pending (id INTEGER PRIMARY KEY)",
      });
      const pendingToken = text(proposeRes).match(/Token: (\S+)/)[1];
      // Deliberately never confirmed.

      const { handler } = registered.get("extraction_log_record");
      const out = await handler({ source_hash: sourceHash, db_execute_token: pendingToken, template_name: "meridian-fiber-bill" });
      assert.ok(out.isError);
      assert.match(text(out), /not "executed"/);
    });

    test("rejects a real, executed token that belongs to a different tool (extraction_template_propose, not db_execute)", async () => {
      const { handler } = registered.get("extraction_log_record");
      const out = await handler({ source_hash: sourceHash, db_execute_token: proposalToken, template_name: "meridian-fiber-bill" });
      assert.ok(out.isError);
      assert.match(text(out), /does not correspond to a real db_execute confirmation/);
    });

    let realToken;
    async function confirmedWrite(sql, params) {
      const proposeRes = await db.get("db_execute").handler({ connection: "extraction", sql, params });
      const token = text(proposeRes).match(/Token: (\S+)/)[1];
      const commit = await db.get("db_execute").handler({ confirmation_token: token });
      assert.match(text(commit), /✅ Executed/, `write must actually succeed: ${text(commit)}`);
      return token;
    }

    test("rejects an executed write that is not an INSERT — the exact exploit this fix closes", async () => {
      // Round 2's fix only checked "some write executed against the extraction
      // connection" — a confirmed CREATE TABLE satisfied that and could then be
      // used to falsely record ANY source_hash as extracted. This is that exact
      // scenario, now expected to fail.
      const ddlToken = await confirmedWrite("CREATE TABLE t_real (id INTEGER PRIMARY KEY, source_hash TEXT)");

      const { handler } = registered.get("extraction_log_record");
      const out = await handler({ source_hash: sourceHash, db_execute_token: ddlToken, template_name: "meridian-fiber-bill" });
      assert.ok(out.isError);
      assert.match(text(out), /not an INSERT/);
    });

    test("rejects an executed INSERT whose params never actually contain the claimed source_hash", async () => {
      const insertToken = await confirmedWrite(
        "INSERT INTO t_real (source_hash) VALUES (?)", ["totally-unrelated-hash"]
      );

      const { handler } = registered.get("extraction_log_record");
      const out = await handler({ source_hash: sourceHash, db_execute_token: insertToken, template_name: "meridian-fiber-bill" });
      assert.ok(out.isError);
      assert.match(text(out), /was not found among that INSERT's bound parameters/);
    });

    test("accepts a genuine, executed INSERT whose params actually contain the claimed source_hash", async () => {
      realToken = await confirmedWrite("INSERT INTO t_real (source_hash) VALUES (?)", [sourceHash]);

      const { handler: logRecord } = registered.get("extraction_log_record");
      const out = json(await logRecord({ source_hash: sourceHash, db_execute_token: realToken, template_name: "meridian-fiber-bill", row_count: 1 }));
      assert.equal(out.status, "recorded");
      assert.equal(out.log.source_hash, sourceHash);
      assert.equal(out.log.verification_state, "unverified");

      const check = json(await registered.get("extraction_log_check").handler({ source_hash: sourceHash }));
      assert.ok(check.alreadyExtracted, "log_check must now see the row log_record just wrote");
    });

    test("rejects an executed db_execute token whose write was against a different connection", async () => {
      // Simulate a write executed against a connection other than "extraction"
      // by tampering the already-executed interrupt's recorded connection —
      // proves the connection check itself has teeth, independent of status.
      store.db.prepare(`UPDATE agent_interrupts SET canonical_arguments = json_set(canonical_arguments, '$.connection', 'not-extraction') WHERE id = ?`).run(realToken);

      const { handler } = registered.get("extraction_log_record");
      const out = await handler({ source_hash: "some-other-hash", db_execute_token: realToken, template_name: "meridian-fiber-bill" });
      assert.ok(out.isError);
      assert.match(text(out), /against connection "not-extraction"/);
    });
  });

  test("a second apply against the SAME source now reports alreadyExtracted — the actual bug this suite exists to catch", async () => {
    const { handler } = registered.get("extraction_apply");
    const out = json(await handler({ text: BILL, template_name: "meridian-fiber-bill" }));
    assert.ok(out.alreadyExtracted, "dedup must work through the exposed MCP flow, not just the internal function");
    assert.equal(out.fields, undefined);
  });

  test("delete removes the template", async () => {
    const { handler } = registered.get("extraction_template_delete");
    const out = json(await handler({ name: "meridian-fiber-bill" }));
    assert.equal(out.status, "deleted");

    const list = json(await registered.get("extraction_template_list").handler({}));
    assert.deepEqual(list.templates, []);
  });

  test("deleting again is a clean not-found error, not a crash", async () => {
    const { handler } = registered.get("extraction_template_delete");
    const out = await handler({ name: "meridian-fiber-bill" });
    assert.ok(out.isError);
  });
});
