// tests/lib/agent-skill-management.test.js
// Coverage for the skill-management surface on the agent object
// (lib/agent/index.js: getSkillDoc, getSkillList, getSkillsForManagement,
// getSkillForEdit, saveSkill, setSkillLoad, deleteSkill, resetSkill) — the
// logic backing /api/skill* (lib/routes/api-meta.js), which is otherwise only
// tested with these methods mocked out (tests/lib/routes/api-meta.test.js).
//
// Each test builds a real temp project root with a skills/ dir and drives the
// agent's overlay-file read/write path end to end (no mocked skills.js).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createAgent } from "../../lib/agent.js";

// Prevent StdioClientTransport from spawning the real MCP child process.
const stubMcpTransport = (t) => {
  t.mock.method(StdioClientTransport.prototype, "start", async () => {});
  t.mock.method(StdioClientTransport.prototype, "close", async () => {});
  t.mock.method(Client.prototype, "connect", async () => {});
  t.mock.method(Client.prototype, "listTools", async () => ({ tools: [] }));
  t.mock.method(Client.prototype, "callTool", async () => ({
    content: [{ type: "text", text: "No memories found." }],
  }));
};

let root;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aperio-skill-mgmt-"));
  fs.mkdirSync(path.join(root, "skills", "greeter"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "skills", "greeter", "SKILL.md"),
    [
      "---",
      "name: greeter",
      "description: Greets the user warmly",
      "metadata:",
      "  keywords: hello hi",
      "  load: on-demand",
      "---",
      "",
      "Say hello.",
    ].join("\n"),
    "utf8",
  );
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("agent skill management", () => {
  test("getSkillDoc strips frontmatter and returns null for unknown skills", async (t) => {
    stubMcpTransport(t);
    const agent = await createAgent({ root, version: "1.0.0" });

    const doc = agent.getSkillDoc("greeter");
    assert.equal(doc.name, "greeter");
    assert.doesNotMatch(doc.content, /^---/);
    assert.match(doc.content, /Say hello\./);

    assert.equal(agent.getSkillDoc("does-not-exist"), null);
  });

  test("getSkillList excludes disabled (load: never) skills", async (t) => {
    stubMcpTransport(t);
    const agent = await createAgent({ root, version: "1.0.0" });

    assert.ok(agent.getSkillList().some((s) => s.name === "greeter"));

    agent.setSkillLoad("greeter", "never");
    assert.ok(!agent.getSkillList().some((s) => s.name === "greeter"));

    agent.resetSkill("greeter"); // restore for later tests
  });

  test("getSkillsForManagement includes flags and disabled skills, sorted by name", async (t) => {
    stubMcpTransport(t);
    const agent = await createAgent({ root, version: "1.0.0" });

    agent.saveSkill({ name: "aardvark", description: "A user skill", body: "Body." });

    const list = agent.getSkillsForManagement();
    const names = list.map((s) => s.name);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));

    const greeter = list.find((s) => s.name === "greeter");
    assert.equal(greeter.source, "bundled");
    assert.equal(greeter.overridden, false);
    assert.equal(greeter.disabled, false);

    const aardvark = list.find((s) => s.name === "aardvark");
    assert.equal(aardvark.source, "user");
    assert.equal(aardvark.disabled, false);

    agent.deleteSkill("aardvark"); // clean up (user skill → removed outright)
  });

  test("getSkillForEdit returns editable fields and null for unknown skills", async (t) => {
    stubMcpTransport(t);
    const agent = await createAgent({ root, version: "1.0.0" });

    const edit = agent.getSkillForEdit("greeter");
    assert.equal(edit.name, "greeter");
    assert.equal(edit.description, "Greets the user warmly");
    assert.match(edit.body, /Say hello\./);
    assert.equal(edit.source, "bundled");

    assert.equal(agent.getSkillForEdit("does-not-exist"), null);
  });

  test("saveSkill rejects invalid slugs and invalid load values", async (t) => {
    stubMcpTransport(t);
    const agent = await createAgent({ root, version: "1.0.0" });

    assert.throws(
      () => agent.saveSkill({ name: "Not Valid", body: "x" }),
      /lowercase letters, numbers and hyphens/,
    );
    assert.throws(
      () => agent.saveSkill({ name: "ok-name", load: "sometimes", body: "x" }),
      /Invalid load value/,
    );
  });

  test("saveSkill creates a new user skill that survives a fresh createAgent (persisted overlay)", async (t) => {
    stubMcpTransport(t);
    const agent = await createAgent({ root, version: "1.0.0" });

    const saved = agent.saveSkill({
      name: "capybara", description: "A user skill", keywords: "capybara", load: "on-demand", body: "Capybara body.",
    });
    assert.equal(saved.name, "capybara");
    assert.match(saved.body, /Capybara body\./);

    // Re-create the agent (re-reads skills/ + var/skills/ from disk) to prove
    // the overlay file, not just the in-memory index, was written.
    stubMcpTransport(t);
    const agent2 = await createAgent({ root, version: "1.0.0" });
    assert.ok(agent2.getSkillList().some((s) => s.name === "capybara"));

    agent.deleteSkill("capybara"); // clean up
  });

  test("saveSkill overrides a bundled skill via an overlay, marking it overridden", async (t) => {
    stubMcpTransport(t);
    const agent = await createAgent({ root, version: "1.0.0" });

    agent.saveSkill({ name: "greeter", description: "Custom greeting", load: "on-demand", body: "Custom body." });
    const edit = agent.getSkillForEdit("greeter");
    assert.equal(edit.overridden, true);
    assert.equal(edit.source, "user");
    assert.match(edit.body, /Custom body\./);

    agent.resetSkill("greeter"); // restore the shipped default for later tests
  });

  test("setSkillLoad toggles always-on without touching the body, and rejects bad input", async (t) => {
    stubMcpTransport(t);
    const agent = await createAgent({ root, version: "1.0.0" });

    const before = agent.getSkillForEdit("greeter");
    const updated = agent.setSkillLoad("greeter", "always");
    assert.equal(updated.load, "always");
    assert.equal(updated.body.trim(), before.body.trim());

    assert.throws(() => agent.setSkillLoad("greeter", "sometimes"), /Invalid load value/);
    assert.throws(() => agent.setSkillLoad("does-not-exist", "always"), /Skill not found/);

    agent.resetSkill("greeter"); // restore
  });

  test("deleteSkill removes a user skill outright but only disables a bundled one", async (t) => {
    stubMcpTransport(t);
    const agent = await createAgent({ root, version: "1.0.0" });

    // User-created skill: fully removed.
    agent.saveSkill({ name: "temp-skill", body: "x" });
    const removedResult = agent.deleteSkill("temp-skill");
    assert.deepEqual(removedResult, { removed: true, disabled: false });
    assert.equal(agent.getSkillForEdit("temp-skill"), null);

    // Bundled skill: disabled (load: never), not deleted, and restorable.
    const disabledResult = agent.deleteSkill("greeter");
    assert.deepEqual(disabledResult, { removed: false, disabled: true });
    const afterDelete = agent.getSkillForEdit("greeter");
    assert.equal(afterDelete.load, "never");
    assert.equal(afterDelete.source, "user"); // shadowed by the disabling overlay

    agent.resetSkill("greeter"); // restore for later tests
    assert.throws(() => agent.deleteSkill("does-not-exist"), /Skill not found/);
  });

  test("resetSkill drops the overlay and restores the bundled default", async (t) => {
    stubMcpTransport(t);
    const agent = await createAgent({ root, version: "1.0.0" });

    agent.saveSkill({ name: "greeter", description: "Overridden", load: "never", body: "Overridden body." });
    assert.equal(agent.getSkillForEdit("greeter").source, "user");

    const reset = agent.resetSkill("greeter");
    assert.equal(reset.source, "bundled");
    assert.equal(reset.overridden, false);
    assert.equal(reset.load, "on-demand");
    assert.match(reset.body, /Say hello\./);
  });
});
