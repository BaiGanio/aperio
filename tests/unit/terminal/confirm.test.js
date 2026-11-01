// Tests for lib/terminal/confirm.js — the transport-neutral confirmation and
// interrupt interaction layer (#539, P1).
//
// Everything here is pure: no socket, no agent, no database. That is the point
// of the module — the rules about which pending item a command refers to, and
// whether that item accepts the decision, are the part that must not be wrong,
// and they are now testable on their own.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  DECISIONS,
  buildDecisionMessage,
  createPendingDecisions,
  isDecisionCommand,
  looksLikeRef,
  parseDecisionCommand,
  planDecision,
  renderConfirmPending,
  renderInterruptDecided,
  renderInterrupts,
  renderPendingList,
  summarizeArguments,
  toConfirmEntry,
  toInterruptEntries,
} from "../../../lib/terminal/confirm.js";

/** Drop ANSI so assertions read as the user's eyes see the line. */
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

const CONFIRM_MSG = {
  type: "action_confirm_pending",
  token: "del_7f3a21",
  tool: "delete_file",
  label: "Delete notes.md",
  summary: "Target: /tmp/notes.md",
  destructive: true,
};

const INTERRUPT_ROW = {
  id: "11111111-2222-3333-4444-555555555555",
  tool: "write_file",
  status: "pending",
  allowedDecisions: ["approve", "edit", "reject", "respond"],
  arguments: { path: "/tmp/out.md", content: "hello" },
};

// ═══════════════════════════════════════════════════════════════════════════════
// looksLikeRef — the parse rule that keeps /respond from losing its first word
// ═══════════════════════════════════════════════════════════════════════════════

describe("looksLikeRef", () => {
  test("a bare index is a reference", () => {
    assert.equal(looksLikeRef("1"), true);
    assert.equal(looksLikeRef("12"), true);
  });

  test("a confirm token is a reference", () => {
    for (const t of ["iss_a1", "del_7f3a21", "wr_9b", "db_z0", "idx_4", "tpl_ff"]) {
      assert.equal(looksLikeRef(t), true, t);
    }
  });

  test("an interrupt UUID is a reference", () => {
    assert.equal(looksLikeRef(INTERRUPT_ROW.id), true);
  });

  test("an English word is not a reference", () => {
    for (const w of ["use", "the", "no", "path", "yes"]) {
      assert.equal(looksLikeRef(w), false, w);
    }
  });

  test("empty and undefined are not references", () => {
    assert.equal(looksLikeRef(""), false);
    assert.equal(looksLikeRef(undefined), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseDecisionCommand
// ═══════════════════════════════════════════════════════════════════════════════

describe("parseDecisionCommand", () => {
  test("returns null for a non-decision command", () => {
    assert.equal(parseDecisionCommand("attach ./x.md"), null);
    assert.equal(parseDecisionCommand("help"), null);
    assert.equal(parseDecisionCommand(""), null);
  });

  test("bare approve has no reference and no payload", () => {
    assert.deepEqual(parseDecisionCommand("approve"), { decision: "approve", ref: undefined, payload: "" });
  });

  test("an index is taken as the reference", () => {
    assert.deepEqual(parseDecisionCommand("reject 2"), { decision: "reject", ref: "2", payload: "" });
  });

  test("a token is taken as the reference", () => {
    assert.deepEqual(parseDecisionCommand("approve del_7f3a21"), {
      decision: "approve", ref: "del_7f3a21", payload: "",
    });
  });

  test("respond keeps every word when the first is not a reference", () => {
    assert.deepEqual(parseDecisionCommand("respond use the other path"), {
      decision: "respond", ref: undefined, payload: "use the other path",
    });
  });

  test("respond splits a leading index off the text", () => {
    assert.deepEqual(parseDecisionCommand("respond 2 use the other path"), {
      decision: "respond", ref: "2", payload: "use the other path",
    });
  });

  test("edit keeps the JSON payload intact", () => {
    const parsed = parseDecisionCommand('edit 1 {"path":"a b.md","n":2}');
    assert.equal(parsed.ref, "1");
    assert.deepEqual(JSON.parse(parsed.payload), { path: "a b.md", n: 2 });
  });

  test("is case-insensitive and tolerates extra spaces", () => {
    assert.deepEqual(parseDecisionCommand("  APPROVE   1  "), {
      decision: "approve", ref: "1", payload: "",
    });
  });

  test("a lone argument after respond or edit is payload, not a reference", () => {
    assert.deepEqual(parseDecisionCommand("edit 42"), { decision: "edit", ref: undefined, payload: "42" });
    assert.deepEqual(parseDecisionCommand("respond 2"), { decision: "respond", ref: undefined, payload: "2" });
    // …but a reference is still split off when text follows it.
    assert.deepEqual(parseDecisionCommand("respond 2 ok"), { decision: "respond", ref: "2", payload: "ok" });
  });

  test("pending parses as its own decision", () => {
    assert.equal(parseDecisionCommand("pending").decision, "pending");
  });

  test('does not match a longer word that merely starts with a decision name', () => {
    // "/approvers" is not "/approve" — \b in the pattern must hold.
    assert.equal(parseDecisionCommand("approvers"), null);
  });
});

describe("isDecisionCommand", () => {
  test("accepts every decision verb plus pending", () => {
    for (const c of ["approve", "reject 1", "respond hi", 'edit {"a":1}', "pending"]) {
      assert.equal(isDecisionCommand(c), true, c);
    }
  });

  test("rejects other commands and plain chat", () => {
    for (const c of ["help", "attach ./x", "approvers", "", "summarize this"]) {
      assert.equal(isDecisionCommand(c), false, c);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// entry mapping
// ═══════════════════════════════════════════════════════════════════════════════

describe("toConfirmEntry", () => {
  test("carries token, tool, label, summary and the destructive flag", () => {
    const e = toConfirmEntry(CONFIRM_MSG);
    assert.equal(e.kind, "confirm");
    assert.equal(e.token, "del_7f3a21");
    assert.equal(e.tool, "delete_file");
    assert.equal(e.label, "Delete notes.md");
    assert.equal(e.summary, "Target: /tmp/notes.md");
    assert.equal(e.destructive, true);
  });

  test("offers only approve and reject — a one-shot token cannot be edited", () => {
    assert.deepEqual(toConfirmEntry(CONFIRM_MSG).allowed, ["approve", "reject"]);
  });

  test("falls back to a generic label when the event has none", () => {
    assert.equal(toConfirmEntry({ token: "wr_1", tool: "write_file" }).label, "Confirm action");
  });
});

describe("toInterruptEntries", () => {
  test("keeps the server's allowed decisions", () => {
    assert.deepEqual(toInterruptEntries([INTERRUPT_ROW])[0].allowed, ["approve", "edit", "reject", "respond"]);
  });

  test("drops a decision the service does not define", () => {
    const rows = [{ ...INTERRUPT_ROW, allowedDecisions: ["approve", "detonate"] }];
    assert.deepEqual(toInterruptEntries(rows)[0].allowed, ["approve"]);
  });

  test("an empty or missing allowed list falls back to approve/reject, not to everything", () => {
    assert.deepEqual(toInterruptEntries([{ ...INTERRUPT_ROW, allowedDecisions: [] }])[0].allowed, ["approve", "reject"]);
    assert.deepEqual(toInterruptEntries([{ id: "x", tool: "write_file" }])[0].allowed, ["approve", "reject"]);
  });

  test("marks delete_file and db_execute destructive", () => {
    const rows = toInterruptEntries([
      { id: "a", tool: "delete_file" }, { id: "b", tool: "db_execute" }, { id: "c", tool: "write_file" },
    ]);
    assert.deepEqual(rows.map(r => r.destructive), [true, true, false]);
  });

  test("a non-array is no rows rather than a throw", () => {
    assert.deepEqual(toInterruptEntries(undefined), []);
    assert.deepEqual(toInterruptEntries(null), []);
  });
});

describe("summarizeArguments", () => {
  test("prefers the path", () => {
    assert.equal(summarizeArguments({ path: "/tmp/a.md", content: "x" }), "/tmp/a.md");
  });

  test("falls back through sql, query, folder, title, name", () => {
    assert.equal(summarizeArguments({ sql: "DROP TABLE t" }), "DROP TABLE t");
    assert.equal(summarizeArguments({ folder: "/srv/docs" }), "/srv/docs");
    assert.equal(summarizeArguments({ name: "weekly" }), "weekly");
  });

  test("truncates a very long value instead of flooding the prompt", () => {
    const out = summarizeArguments({ path: "x".repeat(400) });
    assert.equal(out.length, 158);
    assert.ok(out.endsWith("…"));
  });

  test("degrades to the key list when no known field is present", () => {
    assert.equal(summarizeArguments({ alpha: 1, beta: 2 }), "{ alpha, beta }");
  });

  test("empty for nothing useful", () => {
    assert.equal(summarizeArguments(null), "");
    assert.equal(summarizeArguments("nope"), "");
    assert.equal(summarizeArguments({}), "");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createPendingDecisions
// ═══════════════════════════════════════════════════════════════════════════════

describe("createPendingDecisions", () => {
  test("starts empty and says so", () => {
    const p = createPendingDecisions();
    assert.deepEqual(p.list(), []);
    assert.match(p.resolve(undefined).error, /Nothing is awaiting/);
  });

  test("the live confirm proposal leads the list", () => {
    const p = createPendingDecisions();
    p.setInterrupts([INTERRUPT_ROW]);
    p.setConfirm(CONFIRM_MSG);
    assert.deepEqual(p.list().map(e => e.kind), ["confirm", "interrupt"]);
  });

  test("an interrupts replay replaces the previous rows wholesale", () => {
    const p = createPendingDecisions();
    p.setInterrupts([INTERRUPT_ROW, { id: "b", tool: "write_file" }]);
    p.setInterrupts([INTERRUPT_ROW]);
    assert.equal(p.list().length, 1);
  });

  test("a replay does not disturb the live proposal", () => {
    const p = createPendingDecisions();
    p.setConfirm(CONFIRM_MSG);
    p.setInterrupts([]);
    assert.deepEqual(p.list().map(e => e.kind), ["confirm"]);
  });

  test("remove drops just that entry", () => {
    const p = createPendingDecisions();
    p.setConfirm(CONFIRM_MSG);
    p.setInterrupts([INTERRUPT_ROW, { id: "b", tool: "write_file" }]);
    p.remove(p.list()[1]);
    assert.deepEqual(p.list().map(e => e.kind), ["confirm", "interrupt"]);
    assert.equal(p.list()[1].id, "b");
    p.remove(p.list()[0]);
    assert.deepEqual(p.list().map(e => e.kind), ["interrupt"]);
  });

  test("clear empties both kinds", () => {
    const p = createPendingDecisions();
    p.setConfirm(CONFIRM_MSG);
    p.setInterrupts([INTERRUPT_ROW]);
    p.clear();
    assert.deepEqual(p.list(), []);
  });

  // ─── resolve ───────────────────────────────────────────────────────────────

  test("no reference and one pending resolves to it", () => {
    const p = createPendingDecisions();
    p.setConfirm(CONFIRM_MSG);
    assert.equal(p.resolve(undefined).entry.token, "del_7f3a21");
  });

  test("no reference and several pending is refused, never guessed", () => {
    const p = createPendingDecisions();
    p.setConfirm(CONFIRM_MSG);
    p.setInterrupts([INTERRUPT_ROW]);
    const { entry, error } = p.resolve(undefined);
    assert.equal(entry, null);
    assert.match(error, /2 items are awaiting/);
  });

  test("a 1-based index resolves", () => {
    const p = createPendingDecisions();
    p.setConfirm(CONFIRM_MSG);
    p.setInterrupts([INTERRUPT_ROW]);
    assert.equal(p.resolve("1").entry.kind, "confirm");
    assert.equal(p.resolve("2").entry.id, INTERRUPT_ROW.id);
  });

  test("an out-of-range index is an error, not undefined", () => {
    const p = createPendingDecisions();
    p.setConfirm(CONFIRM_MSG);
    // Out of range falls through to prefix matching (see below), so the refusal
    // is the no-match one. Either way it is refused rather than resolving.
    assert.equal(p.resolve("4").entry, null);
    assert.equal(p.resolve("0").entry, null);
    assert.match(p.resolve("4").error, /No pending item/);
  });

  test("a numeric id prefix still resolves — it is not read as a huge index", () => {
    // An interrupt id is a UUID, so "11111111" is both a plausible index and a
    // real prefix. Out of range as an index, it must fall through to the id.
    const p = createPendingDecisions();
    p.setInterrupts([INTERRUPT_ROW]);
    assert.equal(p.resolve("11111111").entry.id, INTERRUPT_ROW.id);
  });

  test("an id or token prefix resolves", () => {
    const p = createPendingDecisions();
    p.setConfirm(CONFIRM_MSG);
    p.setInterrupts([INTERRUPT_ROW]);
    assert.equal(p.resolve("del_7f3a21").entry.kind, "confirm");
    assert.equal(p.resolve("11111111").entry.id, INTERRUPT_ROW.id);
  });

  test("an ambiguous prefix is refused", () => {
    const p = createPendingDecisions();
    p.setInterrupts([{ id: "abc1", tool: "write_file" }, { id: "abc2", tool: "write_file" }]);
    assert.match(p.resolve("abc").error, /matches 2 pending items/);
  });

  test("an unknown prefix is refused", () => {
    const p = createPendingDecisions();
    p.setConfirm(CONFIRM_MSG);
    assert.match(p.resolve("zzz").error, /No pending item matching/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// planDecision — the whole rule set, in one place
// ═══════════════════════════════════════════════════════════════════════════════

describe("planDecision", () => {
  function withBoth() {
    const p = createPendingDecisions();
    p.setConfirm(CONFIRM_MSG);
    p.setInterrupts([INTERRUPT_ROW]);
    return p;
  }

  test("pending asks for the listing", () => {
    assert.deepEqual(planDecision(createPendingDecisions(), "pending"), { action: "list" });
  });

  test("approve on the only pending item is a decision", () => {
    const p = createPendingDecisions();
    p.setConfirm(CONFIRM_MSG);
    const plan = planDecision(p, "approve");
    assert.equal(plan.action, "decide");
    assert.equal(plan.decision, "approve");
    assert.equal(plan.entry.token, "del_7f3a21");
  });

  test("an unparseable command is an error, not a throw", () => {
    assert.equal(planDecision(createPendingDecisions(), "attach ./x").action, "error");
  });

  test("the ambiguity refusal is passed straight through", () => {
    assert.match(planDecision(withBoth(), "approve").message, /2 items are awaiting/);
  });

  test("a decision the entry does not allow is refused, and the refusal names what is allowed", () => {
    const p = createPendingDecisions();
    p.setConfirm(CONFIRM_MSG);
    const plan = planDecision(p, "respond no thanks");
    assert.equal(plan.action, "error");
    assert.match(plan.message, /delete_file does not accept \/respond/);
    assert.match(plan.message, /\/approve or \/reject/);
  });

  test("respond on an interrupt that allows it carries the text", () => {
    const p = createPendingDecisions();
    p.setInterrupts([INTERRUPT_ROW]);
    const plan = planDecision(p, "respond use the other path");
    assert.equal(plan.action, "decide");
    assert.equal(plan.payload, "use the other path");
  });

  test("respond with no text is refused", () => {
    const p = createPendingDecisions();
    p.setInterrupts([INTERRUPT_ROW]);
    assert.match(planDecision(p, "respond").message, /needs the text/);
  });

  test("edit parses its JSON into editedArguments", () => {
    const p = createPendingDecisions();
    p.setInterrupts([INTERRUPT_ROW]);
    const plan = planDecision(p, 'edit {"path":"/tmp/other.md"}');
    assert.equal(plan.action, "decide");
    assert.deepEqual(plan.editedArguments, { path: "/tmp/other.md" });
  });

  test("edit with no payload is refused", () => {
    const p = createPendingDecisions();
    p.setInterrupts([INTERRUPT_ROW]);
    assert.match(planDecision(p, "edit").message, /needs the replacement arguments/);
  });

  test("edit with broken JSON is refused with the parser's complaint", () => {
    const p = createPendingDecisions();
    p.setInterrupts([INTERRUPT_ROW]);
    assert.match(planDecision(p, "edit {not json}").message, /not valid JSON/);
  });

  test("edit with a JSON array or scalar is refused — arguments are an object", () => {
    const p = createPendingDecisions();
    p.setInterrupts([INTERRUPT_ROW]);
    assert.match(planDecision(p, "edit [1,2]").message, /must be a JSON object/);
    assert.match(planDecision(p, "edit null").message, /must be a JSON object/);
  });

  test("edit's single argument is read as the payload, never as a reference", () => {
    // `/edit 42` is a bad JSON body and must say so. `/edit 1 {…}` names item 1.
    const p = createPendingDecisions();
    p.setInterrupts([INTERRUPT_ROW]);
    assert.match(planDecision(p, "edit 42").message, /must be a JSON object/);
    assert.deepEqual(planDecision(p, 'edit 1 {"path":"x"}').editedArguments, { path: "x" });
  });

  test("respond's single argument is read as the text, never as a reference", () => {
    const p = createPendingDecisions();
    p.setInterrupts([INTERRUPT_ROW]);
    assert.equal(planDecision(p, "respond 42").payload, "42");
  });

  test("every decision the service defines is reachable through a command", () => {
    const p = createPendingDecisions();
    p.setInterrupts([INTERRUPT_ROW]);
    const commands = {
      approve: "approve 1", reject: "reject 1",
      respond: "respond 1 because", edit: 'edit 1 {"path":"x"}',
    };
    for (const d of DECISIONS) {
      const plan = planDecision(p, commands[d]);
      assert.equal(plan.action, "decide", `${d} must be reachable`);
      assert.equal(plan.decision, d);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildDecisionMessage — the wire shape
// ═══════════════════════════════════════════════════════════════════════════════

describe("buildDecisionMessage", () => {
  function plan(pendingSetup, cmd) {
    const p = createPendingDecisions();
    pendingSetup(p);
    return planDecision(p, cmd);
  }

  test("approving a live proposal sends confirm_action with the token and tool", () => {
    const msg = buildDecisionMessage(plan(p => p.setConfirm(CONFIRM_MSG), "approve"));
    assert.deepEqual(msg, { type: "confirm_action", token: "del_7f3a21", tool: "delete_file" });
  });

  test("rejecting a live proposal sends nothing — dropping the one-shot token IS the rejection", () => {
    assert.equal(buildDecisionMessage(plan(p => p.setConfirm(CONFIRM_MSG), "reject")), null);
  });

  test("a durable decision sends interrupt_decision with the id", () => {
    const msg = buildDecisionMessage(plan(p => p.setInterrupts([INTERRUPT_ROW]), "approve"));
    assert.equal(msg.type, "interrupt_decision");
    assert.equal(msg.id, INTERRUPT_ROW.id);
    assert.equal(msg.decision, "approve");
  });

  test("respond carries the text in `response`", () => {
    const msg = buildDecisionMessage(plan(p => p.setInterrupts([INTERRUPT_ROW]), "respond try again"));
    assert.equal(msg.response, "try again");
  });

  test("a non-respond decision carries no response field", () => {
    const msg = buildDecisionMessage(plan(p => p.setInterrupts([INTERRUPT_ROW]), "reject"));
    assert.equal(msg.response, undefined);
  });

  test("edit carries editedArguments", () => {
    const msg = buildDecisionMessage(plan(p => p.setInterrupts([INTERRUPT_ROW]), 'edit {"path":"/tmp/z.md"}'));
    assert.deepEqual(msg.editedArguments, { path: "/tmp/z.md" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// renderers — what the user actually reads
// ═══════════════════════════════════════════════════════════════════════════════

describe("renderConfirmPending", () => {
  const text = plain(renderConfirmPending(toConfirmEntry(CONFIRM_MSG)));

  test("names the tool, the action and the target", () => {
    assert.match(text, /confirmation required/);
    assert.match(text, /action:\s*Delete notes\.md/);
    assert.match(text, /tool:\s*delete_file/);
    assert.match(text, /\/tmp\/notes\.md/);
  });

  test("shows the token — the manual fallback must stay visible", () => {
    assert.match(text, /token:\s*del_7f3a21/);
  });

  test("offers the decisions it allows and nothing else", () => {
    assert.match(text, /\/approve/);
    assert.match(text, /\/reject/);
    assert.doesNotMatch(text, /\/respond/);
    assert.doesNotMatch(text, /\/edit/);
  });

  test("flags a destructive action as such", () => {
    assert.match(text, /\(destructive\)/);
    assert.doesNotMatch(
      plain(renderConfirmPending(toConfirmEntry({ ...CONFIRM_MSG, destructive: false, tool: "write_file" }))),
      /\(destructive\)/,
    );
  });

  test("a multi-line summary stays readable rather than collapsing", () => {
    const e = toConfirmEntry({ ...CONFIRM_MSG, summary: "line one\nline two" });
    const out = plain(renderConfirmPending(e));
    assert.match(out, /line one/);
    assert.match(out, /line two/);
  });
});

describe("renderInterrupts", () => {
  test("says nothing when nothing is pending — this event fires on every connect", () => {
    assert.equal(renderInterrupts([]), "");
  });

  test("numbers the rows and names each tool and target", () => {
    const out = plain(renderInterrupts(toInterruptEntries([INTERRUPT_ROW])));
    assert.match(out, /1 action awaiting your decision/);
    assert.match(out, /1\.\s*write_file/);
    assert.match(out, /\/tmp\/out\.md/);
  });

  test("the offset continues the numbering past a live proposal", () => {
    const out = plain(renderInterrupts(toInterruptEntries([INTERRUPT_ROW]), 1));
    assert.match(out, /2\.\s*write_file/);
    assert.match(out, /\/approve 2/);
    assert.doesNotMatch(out, /\/approve 1\b/);
  });

  test("pluralizes the count", () => {
    const rows = toInterruptEntries([INTERRUPT_ROW, { id: "b", tool: "write_file" }]);
    assert.match(plain(renderInterrupts(rows)), /2 actions awaiting/);
  });

  test("offers edit and respond when the row allows them", () => {
    const out = plain(renderInterrupts(toInterruptEntries([INTERRUPT_ROW])));
    assert.match(out, /\/edit 1 <json>/);
    assert.match(out, /\/respond 1 <text>/);
  });
});

describe("renderInterruptDecided", () => {
  test("a rejection says plainly that nothing ran", () => {
    const out = plain(renderInterruptDecided({ decision: "reject", interrupt: { tool: "delete_file" } }));
    assert.match(out, /rejected — delete_file did not run/);
  });

  test("a response says plainly that nothing ran", () => {
    const out = plain(renderInterruptDecided({ decision: "respond", interrupt: { tool: "write_file" } }));
    assert.match(out, /did not run/);
  });

  test("an approval is a one-line receipt", () => {
    assert.match(plain(renderInterruptDecided({ decision: "approve", interrupt: { tool: "write_file" } })), /approved/);
  });

  test("an edit approval says the edits were applied", () => {
    assert.match(plain(renderInterruptDecided({ decision: "edit", interrupt: { tool: "write_file" } })), /approved with edits/);
  });

  test("a missing interrupt payload degrades to 'action'", () => {
    assert.match(plain(renderInterruptDecided({ decision: "approve" })), /action/);
  });
});

describe("renderPendingList", () => {
  test("says so when nothing is pending", () => {
    assert.match(plain(renderPendingList([])), /nothing is awaiting a decision/);
  });

  test("numbers every entry and prints its reference", () => {
    const p = createPendingDecisions();
    p.setConfirm(CONFIRM_MSG);
    p.setInterrupts([INTERRUPT_ROW]);
    const out = plain(renderPendingList(p.list()));
    assert.match(out, /1\.\s*delete_file del_7f3a21/);
    assert.match(out, new RegExp(`2\\.\\s*write_file ${INTERRUPT_ROW.id}`));
  });
});
