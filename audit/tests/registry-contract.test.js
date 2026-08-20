// T2.3 (registry half) — audit/scripts/registry-contract.js
// (aperio-continuous-audit-tests.md, T2.3).
//
// The plan's fixture: "fixture registry omits a tool module". The gate must
// name the module mcp/index.js never imported, and must compare the internal
// (agent) and standalone (MCP host) tool-name catalogs rather than trusting the
// tools directory listing. The reviewed-exception case is exercised in both
// directions: an internal-only tool on record passes, and an exception whose
// stated reason no longer holds in the code fails.
//
// The T5.1 red/green proof is run against REAL source, not only fixtures: the
// real mcp/index.js is mutated in memory (its docgraph import deleted) and fed
// back through the same parser the contract check uses, so the gate is proven
// to go red on genuine repo text and green again on the untouched file.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  registrarNameFor,
  parseToolModuleWiring,
  listToolModules,
  collectModuleTools,
  profileToolNames,
  hostToolDescriptors,
  checkToolRegistry,
  checkToolRegistryContract,
  REVIEWED_INTERNAL_ONLY_TOOLS,
  REVIEWED_UNREGISTERED_MODULES,
} from "../scripts/registry-contract.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MCP_INDEX_SOURCE = readFileSync(`${ROOT}/mcp/index.js`, "utf8");

const MODULES = ["memory.js", "self-memory.js", "files.js", "docgraph.js"];

/** A fixture registry where the directory, the wiring and both catalogs agree. */
function fixture(modules = MODULES, overrides = {}) {
  const pairs = modules.map((m) => ({ binding: registrarNameFor(m), module: m }));
  const moduleTools = Object.fromEntries(modules.map((m) => [m, [`${m.replace(/\W/g, "_")}_tool`]]));
  return {
    moduleFiles: modules,
    wiring: { pairs, foreign: [], calls: pairs.map((p) => p.binding) },
    moduleTools,
    noRegister: [],
    profileTools: Object.values(moduleTools).flat(),
    hostProfileTools: [],
    hostTools: [],
    internalOnly: {},
    unregisteredModules: {},
    ...overrides,
  };
}

describe("audit/scripts/registry-contract.js", () => {
  test("a fixture where the directory, the wiring and both catalogs agree passes", () => {
    const result = checkToolRegistry(fixture());
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
    assert.deepStrictEqual(result.catalog.modules, MODULES);
  });

  test("T2.3 — the registry omits a tool module: the gate fails and names it", () => {
    const base = fixture();
    base.wiring.pairs = base.wiring.pairs.filter((p) => p.module !== "docgraph.js");
    base.wiring.calls = base.wiring.pairs.map((p) => p.binding);
    const result = checkToolRegistry(base);
    assert.strictEqual(result.ok, false);
    const omitted = result.errors.filter((e) => e.startsWith("mcp/tools/docgraph.js:"));
    assert.strictEqual(omitted.length, 1, JSON.stringify(result.errors));
    assert.ok(omitted[0].includes("never imported"));
    // The module's own tools are then reported as phantoms — the profile still
    // promises them, but neither catalog can serve them.
    assert.ok(result.errors.some((e) => e.startsWith("docgraph_js_tool:") && e.includes("phantom")));
    // The other three modules are untouched: one unwired module is not a suite-wide alarm.
    assert.deepStrictEqual(result.catalog.modules, ["memory.js", "self-memory.js", "files.js"]);
  });

  test("T2.3 — a module imported but never called is inert, and is reported " +
    "separately from one that was never imported", () => {
    const base = fixture();
    base.wiring.calls = base.wiring.calls.filter((c) => c !== "registerFiles");
    const result = checkToolRegistry(base);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.startsWith("mcp/tools/files.js:") && e.includes("never called")));
  });

  test("T2.3 — the two positional arrays are zipped by index, so a misaligned " +
    "binding is caught instead of registering the wrong module", () => {
    const base = fixture();
    base.wiring.pairs = [
      { binding: "registerMemory", module: "self-memory.js" },
      { binding: "registerSelfMemory", module: "memory.js" },
      ...base.wiring.pairs.slice(2),
    ];
    const result = checkToolRegistry(base);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.startsWith("mcp/tools/self-memory.js:") && e.includes("registerSelfMemory")));
    assert.ok(result.errors.some((e) => e.startsWith("mcp/tools/memory.js:") && e.includes("registerMemory")));
  });

  test("T2.3 — a registrar paired with a non-tools module, and a call with no " +
    "import, are both reported", () => {
    const drifted = checkToolRegistry(fixture(MODULES, {
      wiring: {
        pairs: fixture().wiring.pairs,
        foreign: [{ binding: "register: registerHandlers", specifier: "../lib/handlers/x.js" }],
        calls: [...MODULES.map(registrarNameFor), "registerGhost"],
      },
    }));
    assert.strictEqual(drifted.ok, false);
    assert.ok(drifted.errors.some((e) => e.includes("registerHandlers") && e.includes("positional arrays")));
    assert.ok(drifted.errors.some((e) => e.includes("registerGhost()") && e.includes("ReferenceError")));
  });

  test("T2.3 — modules with no register() export, no tools, or a duplicated " +
    "tool name each fail on their own", () => {
    const noExport = checkToolRegistry(fixture(MODULES, { noRegister: ["ghost.js"] }));
    assert.ok(noExport.errors.some((e) => e.includes("ghost.js") && e.includes("does not export register()")));

    const empty = fixture();
    empty.moduleTools["files.js"] = [];
    empty.profileTools = Object.values(empty.moduleTools).flat();
    assert.ok(checkToolRegistry(empty).errors.some((e) => e.includes("registers no tool at all")));

    const clash = fixture();
    clash.moduleTools["files.js"] = ["memory_js_tool"];
    clash.profileTools = [...new Set(Object.values(clash.moduleTools).flat())];
    assert.ok(checkToolRegistry(clash).errors.some((e) => e.startsWith("memory_js_tool:") && e.includes("overwrites")));
  });

  test("T2.3 — internal and standalone catalogs are compared: a host-only tool " +
    "must be on the reviewed registry, and the entry must stay true", () => {
    const withHost = (overrides) => fixture(MODULES, {
      hostProfileTools: ["index_folder"],
      hostTools: [{ name: "index_folder", override: false }],
      ...overrides,
    });

    // Unreviewed divergence fails.
    const unreviewed = checkToolRegistry(withHost({}));
    assert.strictEqual(unreviewed.ok, false);
    assert.ok(unreviewed.errors.some((e) => e.startsWith("index_folder:") && e.includes("stated reason")));

    // On record, it passes — and lands in the internal catalog only.
    const reviewed = checkToolRegistry(withHost({
      internalOnly: { index_folder: { reason: "web-process watcher", hostOnly: true } },
    }));
    assert.strictEqual(reviewed.ok, true, JSON.stringify(reviewed.errors));
    assert.deepStrictEqual(reviewed.catalog.hostOnly, ["index_folder"]);
    assert.ok(reviewed.catalog.internal.includes("index_folder"));
    assert.ok(!reviewed.catalog.standalone.includes("index_folder"));

    // The exception stops holding the moment an MCP module registers the same
    // name — which is the real boot crash registerHostTools() would throw.
    const collided = withHost({ internalOnly: { index_folder: { reason: "web-process watcher", hostOnly: true } } });
    collided.moduleTools["files.js"] = [...collided.moduleTools["files.js"], "index_folder"];
    const result = checkToolRegistry(collided);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("stated reason no longer holds")));
    assert.ok(result.errors.some((e) => e.includes("Duplicate tool name")));
  });

  test("T2.3 — an override host tool with no MCP twin is dropped silently by " +
    "registerHostTools(), so the gate reports it", () => {
    const orphaned = checkToolRegistry(fixture(MODULES, {
      hostTools: [{ name: "generate_xlsx", override: true }],
    }));
    assert.strictEqual(orphaned.ok, false);
    assert.ok(orphaned.errors.some((e) => e.startsWith("generate_xlsx:") && e.includes("bare `continue`")));

    const paired = fixture(MODULES, { hostTools: [{ name: "generate_xlsx", override: true }] });
    paired.moduleTools["files.js"] = [...paired.moduleTools["files.js"], "generate_xlsx"];
    assert.strictEqual(checkToolRegistry(paired).ok, true);
  });

  test("T2.3 — a HOST_TOOL_PROFILES name with no host-tool factory is a phantom, " +
    "and a stale reviewed entry fails", () => {
    const phantom = checkToolRegistry(fixture(MODULES, { hostProfileTools: ["index_folder"] }));
    assert.ok(phantom.errors.some((e) => e.startsWith("index_folder:") && e.includes("no host-tool factory")));

    const stale = checkToolRegistry(fixture(MODULES, {
      internalOnly: { removed_tool: { reason: "gone", hostOnly: true } },
    }));
    assert.ok(stale.errors.some((e) => e.startsWith("removed_tool:") && e.includes("stale")));
  });

  test("T2.3 — a reviewed-unregistered module passes, and its entry goes stale " +
    "in both directions", () => {
    const base = fixture();
    base.wiring.pairs = base.wiring.pairs.filter((p) => p.module !== "docgraph.js");
    base.wiring.calls = base.wiring.pairs.map((p) => p.binding);
    base.profileTools = base.profileTools.filter((t) => t !== "docgraph_js_tool");
    base.unregisteredModules = { "docgraph.js": { reason: "not wired yet" } };
    assert.strictEqual(checkToolRegistry(base).ok, true, JSON.stringify(checkToolRegistry(base).errors));

    // Wired after all → the exception is stale.
    const wired = checkToolRegistry(fixture(MODULES, {
      unregisteredModules: { "docgraph.js": { reason: "not wired yet" } },
    }));
    assert.ok(wired.errors.some((e) => e.includes("docgraph.js") && e.includes("does import it")));

    // File deleted → the exception is stale the other way.
    const gone = checkToolRegistry(fixture(MODULES, {
      unregisteredModules: { "removed.js": { reason: "not wired yet" } },
    }));
    assert.ok(gone.errors.some((e) => e.includes("removed.js") && e.includes("no longer exists")));
  });

  test("registrarNameFor follows the convention the real mcp/index.js uses", () => {
    assert.strictEqual(registrarNameFor("memory.js"), "registerMemory");
    assert.strictEqual(registrarNameFor("self-memory.js"), "registerSelfMemory");
    assert.strictEqual(registrarNameFor("self-wiki.js"), "registerSelfWiki");
  });

  test("parseToolModuleWiring reads the real mcp/index.js: every tools/ module is " +
    "paired with its registrar, and the non-registrar import rides along separately", () => {
    const wiring = parseToolModuleWiring(MCP_INDEX_SOURCE);
    assert.ok(wiring.pairs.length >= 14, `only ${wiring.pairs.length} pairs parsed`);
    for (const { binding, module } of wiring.pairs) {
      assert.strictEqual(binding, registrarNameFor(module));
      assert.ok(wiring.calls.includes(binding), `${binding} parsed but no call found`);
    }
    // mcp/index.js's clearSessionCacheHandler is imported from lib/handlers/,
    // not mcp/tools/ — it must be classified as foreign, not as a lost registrar.
    assert.ok(wiring.foreign.some((f) => f.specifier?.includes("docgraphHandlers.js")));
    assert.ok(!wiring.foreign.some((f) => /^register\s*:/.test(f.binding ?? "")));
  });

  test("parseToolModuleWiring throws rather than passing vacuously when the " +
    "import block cannot be found", () => {
    assert.throws(() => parseToolModuleWiring("export async function startServer() {}"), /tool-import block/);
  });

  test("T5.1 red/green proof against REAL source — deleting docgraph's import " +
    "from the actual mcp/index.js text turns the gate red; the untouched file is green", async () => {
    const moduleFiles = listToolModules();
    const { moduleTools, noRegister } = await collectModuleTools(moduleFiles);
    const shared = {
      moduleFiles,
      moduleTools,
      noRegister,
      profileTools: profileToolNames(),
      hostProfileTools: ["index_folder"],
      hostTools: hostToolDescriptors(),
    };

    // The exact two lines that wire docgraph in, removed from real repo text.
    const mutated = MCP_INDEX_SOURCE
      .replace("    { register: registerDocgraph },\n", "")
      .replace('    import("./tools/docgraph.js"),\n', "")
      .replace("  registerDocgraph(server, ctx);\n", "");
    assert.notStrictEqual(mutated, MCP_INDEX_SOURCE, "the mutation did not apply — source shape changed");

    const red = checkToolRegistry({ ...shared, wiring: parseToolModuleWiring(mutated) });
    assert.strictEqual(red.ok, false);
    assert.ok(red.errors.some((e) => e.startsWith("mcp/tools/docgraph.js:") && e.includes("never imported")),
      JSON.stringify(red.errors, null, 2));
    // Every doc_* tool is reported unreachable, not just the module.
    for (const name of ["doc_search", "doc_repos", "doc_batch"]) {
      assert.ok(red.errors.some((e) => e.startsWith(`${name}:`) && e.includes("phantom")), `${name} not reported`);
    }

    const green = checkToolRegistry({ ...shared, wiring: parseToolModuleWiring(MCP_INDEX_SOURCE) });
    assert.strictEqual(green.ok, true, JSON.stringify(green.errors, null, 2));
  });

  test("T5.1 red/green proof against REAL source — a host tool colliding with a " +
    "real MCP registration turns the gate red", async () => {
    const moduleFiles = listToolModules();
    const { moduleTools, noRegister } = await collectModuleTools(moduleFiles);
    const collided = { ...moduleTools, "files.js": [...moduleTools["files.js"], "index_folder"] };
    const result = checkToolRegistry({
      moduleFiles,
      wiring: parseToolModuleWiring(MCP_INDEX_SOURCE),
      moduleTools: collided,
      noRegister,
      profileTools: profileToolNames(),
      hostProfileTools: ["index_folder"],
      hostTools: hostToolDescriptors(),
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("Duplicate tool name")));
  });

  test("current real state — every mcp/tools module is wired into mcp/index.js, " +
    "and the internal catalog is the standalone catalog plus index_folder", async () => {
    const result = await checkToolRegistryContract();
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors, null, 2));

    assert.deepStrictEqual(result.catalog.modules.sort(), listToolModules());
    assert.deepStrictEqual(result.catalog.hostOnly, ["index_folder"]);
    assert.deepStrictEqual(
      result.catalog.internal,
      [...result.catalog.standalone, "index_folder"].sort()
    );
    // Every profile-reachable tool resolves in the internal catalog.
    for (const name of profileToolNames()) {
      assert.ok(result.catalog.internal.includes(name), `${name} is reachable but not in any catalog`);
    }
    // index_folder is the one internal/standalone divergence on record, and no
    // module is exempted from registration.
    assert.deepStrictEqual(Object.keys(REVIEWED_INTERNAL_ONLY_TOOLS), ["index_folder"]);
    assert.deepStrictEqual(Object.keys(REVIEWED_UNREGISTERED_MODULES), []);
  });
});
