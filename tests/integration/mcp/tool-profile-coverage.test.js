// tests/mcp/tool-profile-coverage.test.js
//
// Guard against the bug class behind the unreachable docgraph tools: an MCP tool
// can be registered in mcp/tools/*.js yet referenced by NO entry in TOOL_PROFILES,
// in which case getOpenAiTools/getAnthropicTools never offer it to the model and
// the feature is silently dead through the agent (it failed with the honest
// "couldn't issue the call correctly" fallback). The inverse — a profile naming a
// tool that no longer exists — is just as bad: the model is told about a phantom.
//
// This asserts a strict bijection between the two sets, so adding a tool without a
// profile (or deleting a tool still named in a profile) fails CI instead of
// shipping a stranded tool. The registered set is captured from the REAL register()
// functions via a mock server, and the module list is read from the filesystem so a
// brand-new mcp/tools/*.js file is covered automatically.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TOOL_PROFILES, FIRST_TURN_TOOLS } from "../../../lib/agent/tool-profiles.js";

const TOOLS_DIR = fileURLToPath(new URL("../../mcp/tools/", import.meta.url));

// A ctx that answers any property access (and call) with another such proxy, so
// register()/createBoundHandlers() can read ctx freely without a real DB, store,
// or filesystem — registration only builds handler closures, it never runs them.
const deepStub = new Proxy(function () {}, {
  get: () => deepStub,
  apply: () => deepStub,
});

async function collectRegisteredTools() {
  const names = new Set();
  const server = {
    registerTool: (name) => {
      assert.ok(!names.has(name), `duplicate tool registration: "${name}"`);
      names.add(name);
    },
  };
  const files = fs.readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".js"));
  for (const file of files) {
    const mod = await import(path.join(TOOLS_DIR, file));
    assert.equal(typeof mod.register, "function", `${file} must export register()`);
    mod.register(server, deepStub);
  }
  return names;
}

function reachableTools() {
  return new Set([
    ...FIRST_TURN_TOOLS,
    ...Object.values(TOOL_PROFILES).flatMap((s) => [...s]),
  ]);
}

describe("tool-profile coverage — registered ⇔ reachable bijection", () => {
  test("every registered MCP tool is reachable through some tool profile", async () => {
    const registered = await collectRegisteredTools();
    const reachable = reachableTools();
    const stranded = [...registered].filter((t) => !reachable.has(t)).sort();
    assert.deepEqual(
      stranded,
      [],
      `These tools are registered but in NO TOOL_PROFILE (FIRST_TURN_TOOLS), so the ` +
        `agent can never offer them to the model: ${stranded.join(", ")}. ` +
        `Add each to a profile in lib/agent/tool-profiles.js and a classifyProfiles branch.`
    );
  });

  test("every tool named in a profile is actually registered", async () => {
    const registered = await collectRegisteredTools();
    const reachable = reachableTools();
    const phantom = [...reachable].filter((t) => !registered.has(t)).sort();
    assert.deepEqual(
      phantom,
      [],
      `These tools are named in a TOOL_PROFILE/FIRST_TURN_TOOLS but are NOT registered ` +
        `by any mcp/tools/*.js — the model is told about a phantom tool: ${phantom.join(", ")}.`
    );
  });
});
