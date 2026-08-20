// audit/scripts/registry-contract.js
//
// T2.3 (registry half) — MCP tool-registry completeness for the continuous-audit
// program (aperio-continuous-audit.md Step 2, T2.3; audit slice A12, "internal
// and external callers receive equivalent contracts"). The ctx half of T2.3 —
// a handler reading a ctx field createContext never supplies — is already
// gated by memory-contract.js; this is the other half the plan names: "fixture
// registry omits a tool module … internal and standalone tool names are
// compared".
//
// The gap this closes: a file in mcp/tools/ registers its tools against
// whatever server object it is handed, so a module can be complete, tested,
// and reachable through TOOL_PROFILES while mcp/index.js never imports it. The
// existing tests/integration/mcp/tool-profile-coverage.test.js reads the tools
// directory ITSELF and calls every register() it finds, so it passes happily on
// a module the real host never wires in — and nothing else compares the two.
//
// The second, quieter drift is between the two catalogs a tool can live in:
//
//   standalone MCP host  =  tools registered by mcp/index.js
//   internal agent host  =  the same, PLUS lib/agent/mcp-connect.js's host tools
//
// registerHostTools() resolves that overlap silently in both directions — a
// non-override host tool whose name is also an MCP tool THROWS at agent boot
// ("Duplicate tool name"), and an override host tool whose MCP twin disappears
// is dropped with a bare `continue`. Neither is a compile error and neither has
// a test, so both are gated here against the real host-tool factories.
//
// Module wiring and the internal/standalone comparison are read from source
// (the drift being caught is textual — an import line that was never added,
// the same choice provider-contract.js and routes-contract.js make), but the
// per-module tool NAMES are collected by calling the real register() functions
// against a mock server: mcp/tools/memory.js registers from a spec loop
// (`server.registerTool(tool.name, …)`), so no regex can read its catalog.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TOOL_PROFILES, HOST_TOOL_PROFILES, FIRST_TURN_TOOLS } from "../../lib/agent/tool-profiles.js";
import { createArtifactGeneratorTools } from "../../lib/agent/host-tools/artifact-generators.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MCP_INDEX = "mcp/index.js";
const TOOLS_DIR = "mcp/tools";

// T2.3's "reviewed exception passes" case for the internal/standalone split: a
// tool the in-process agent can call that a standalone MCP host will never see.
// The divergence is legitimate — index_folder mutates watcher state owned by
// the web process — but it must be a decision on record, because the mechanism
// that makes it work is fragile: registerHostTools() throws "Duplicate tool
// name" at agent boot the moment a non-override host tool's name is ALSO
// registered by mcp/tools/*.js. `hostOnly` is re-checked against the real MCP
// catalog, so the day someone adds an index_folder MCP tool this gate fails
// instead of leaving a boot crash to be discovered live.
export const REVIEWED_INTERNAL_ONLY_TOOLS = {
  index_folder: {
    reason:
      "queues a code/document watcher owned by the web process (lib/server.js's folderIndexer); " +
      "the MCP child has no indexer to queue against, so it is deliberately host-only",
    hostOnly: true,
  },
};

// A module under mcp/tools/ that mcp/index.js deliberately does not register.
// Empty by design: an unwired tool module is dead code until proven otherwise.
export const REVIEWED_UNREGISTERED_MODULES = {};

/** The registrar binding name mcp/index.js must use for a tools module. */
export function registrarNameFor(moduleFile) {
  const base = moduleFile.replace(/\.js$/, "");
  return "register" + base.split("-").map((p) => p[0].toUpperCase() + p.slice(1)).join("");
}

/**
 * The tool-module wiring in mcp/index.js's startServer(): the destructuring
 * array and the Promise.all import array are POSITIONAL, so they are zipped by
 * index rather than matched by name — a mismatch between the two is exactly
 * the bug that would bind registerMemory to files.js.
 *
 * Non-registrar entries (mcp/index.js's `{ clearSessionCacheHandler }`, which
 * rides along from lib/handlers/) are returned separately instead of dropped,
 * so a registrar that silently loses its `register:` key is not mistaken for
 * an absent module.
 */
export function parseToolModuleWiring(source) {
  const block = source.match(/const\s*\[([\s\S]*?)\]\s*=\s*await\s+Promise\.all\(\[([\s\S]*?)\]\);/);
  if (!block) throw new Error(`could not locate startServer()'s tool-import block in ${MCP_INDEX}`);
  const bindings = [...block[1].matchAll(/\{([^}]*)\}/g)].map((m) => m[1].trim());
  const imports = [...block[2].matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);

  const pairs = [];
  const foreign = [];
  for (let i = 0; i < Math.max(bindings.length, imports.length); i++) {
    const binding = bindings[i] ?? null;
    const specifier = imports[i] ?? null;
    const registrar = binding?.match(/^register\s*:\s*(\w+)$/)?.[1] ?? null;
    const toolModule = specifier?.match(/^\.\/tools\/(.+\.js)$/)?.[1] ?? null;
    if (registrar && toolModule) pairs.push({ binding: registrar, module: toolModule });
    else foreign.push({ binding, specifier });
  }

  // `registerX(server…)` statements, which are what actually run. An import
  // whose registrar is never called leaves the module inert.
  const calls = [...source.matchAll(/^\s*(register[A-Z]\w*)\s*\(/gm)].map((m) => m[1]);
  return { pairs, foreign, calls: [...new Set(calls)] };
}

/** Tool-module files under mcp/tools/ (top level only — subdirectories hold
 *  the implementations their sibling module registers, not registrars). */
export function listToolModules() {
  return readdirSync(`${ROOT}/${TOOLS_DIR}`).filter((f) => f.endsWith(".js")).sort();
}

/**
 * Tool names each module registers, captured from the REAL register()
 * functions. The ctx stub answers every property access (and call) with itself
 * so registration can read ctx freely — registration only builds handler
 * closures, it never runs them.
 */
export async function collectModuleTools(moduleFiles = listToolModules()) {
  const deepStub = new Proxy(function () {}, { get: () => deepStub, apply: () => deepStub });
  const moduleTools = {};
  const noRegister = [];
  for (const file of moduleFiles) {
    const mod = await import(`${ROOT}/${TOOLS_DIR}/${file}`);
    if (typeof mod.register !== "function") {
      noRegister.push(file);
      continue;
    }
    const names = [];
    mod.register({ registerTool: (name) => names.push(name) }, deepStub);
    moduleTools[file] = names;
  }
  return { moduleTools, noRegister };
}

/** Every tool name the agent can offer a model through a profile. */
export function profileToolNames() {
  return [...new Set([...FIRST_TURN_TOOLS, ...Object.values(TOOL_PROFILES).flatMap((s) => [...s])])];
}

/** Host-tool descriptors the agent merges in ahead of the MCP catalog. */
export function hostToolDescriptors() {
  // index_folder is constructed with a live folderIndexer in lib/server.js, so
  // its descriptor is read from the factory's source rather than called.
  const source = readFileSync(`${ROOT}/lib/agent/host-tools/index-folder.js`, "utf8");
  const indexFolder = [...source.matchAll(/name:\s*["'](\w+)["']/g)].map((m) => ({
    name: m[1],
    override: /override:\s*true/.test(source),
  }));
  return [...createArtifactGeneratorTools().map((t) => ({ name: t.name, override: t.override === true })), ...indexFolder];
}

/**
 * Reconcile the tools directory, mcp/index.js's wiring, and the two catalogs
 * (standalone MCP host vs in-process agent). Fully injectable so the plan's
 * fixture — a registry that omits a tool module — can be driven without
 * touching the repo.
 */
export function checkToolRegistry({
  moduleFiles = [],
  wiring = { pairs: [], foreign: [], calls: [] },
  moduleTools = {},
  noRegister = [],
  profileTools = [],
  hostProfileTools = [],
  hostTools = [],
  internalOnly = REVIEWED_INTERNAL_ONLY_TOOLS,
  unregisteredModules = REVIEWED_UNREGISTERED_MODULES,
} = {}) {
  const errors = [];
  const { pairs, foreign, calls } = wiring;
  const wired = new Map(pairs.map((p) => [p.module, p]));

  for (const file of noRegister) {
    errors.push(`${TOOLS_DIR}/${file}: does not export register() — every tool module must, ` +
      `or mcp/index.js's registrar binding for it resolves to undefined`);
  }

  // ── Stage 1: every tool module reaches mcp/index.js ────────────────────────
  const registeredModules = [];
  for (const file of moduleFiles) {
    const pair = wired.get(file);
    const reviewed = unregisteredModules[file];
    if (!pair) {
      if (!reviewed) {
        errors.push(`${TOOLS_DIR}/${file}: never imported by ${MCP_INDEX} — its tools are ` +
          `registered on no server, so neither a standalone MCP host nor the agent can call them`);
      }
      continue;
    }
    if (reviewed) {
      errors.push(`${TOOLS_DIR}/${file}: on the reviewed-unregistered registry but ${MCP_INDEX} ` +
        `does import it — the exception is stale`);
    }
    const expected = registrarNameFor(file);
    if (pair.binding !== expected) {
      errors.push(`${TOOLS_DIR}/${file}: imported at the position bound to \`${pair.binding}\`, but ` +
        `the convention names it \`${expected}\` — the destructuring array and the Promise.all array ` +
        `are positional, so this is either a naming break or a real misalignment registering the wrong module`);
      continue;
    }
    if (!calls.includes(pair.binding)) {
      errors.push(`${TOOLS_DIR}/${file}: imported as \`${pair.binding}\` but never called in ` +
        `${MCP_INDEX} — the module is inert and its tools are absent from tools/list()`);
      continue;
    }
    registeredModules.push(file);
  }

  for (const file of Object.keys(unregisteredModules)) {
    if (!moduleFiles.includes(file)) {
      errors.push(`${TOOLS_DIR}/${file}: has a reviewed-unregistered exception but no longer exists — ` +
        `registry entry is stale`);
    }
  }
  for (const { binding, specifier } of foreign) {
    if (binding && /^register\s*:/.test(binding) && !specifier?.startsWith("./tools/")) {
      errors.push(`${MCP_INDEX}: registrar \`${binding}\` is paired with \`${specifier}\`, which is not ` +
        `a ${TOOLS_DIR}/ module — the positional arrays have drifted apart`);
    }
  }
  for (const call of calls) {
    if (!pairs.some((p) => p.binding === call)) {
      errors.push(`${MCP_INDEX}: calls \`${call}()\` but no ${TOOLS_DIR}/ import binds that name — ` +
        `the call throws ReferenceError at server start`);
    }
  }

  // ── Stage 2: the two catalogs ─────────────────────────────────────────────
  const standalone = new Map();
  for (const file of registeredModules) {
    for (const name of moduleTools[file] ?? []) {
      if (standalone.has(name)) {
        errors.push(`${name}: registered by both ${TOOLS_DIR}/${standalone.get(name)} and ` +
          `${TOOLS_DIR}/${file} — the second registration overwrites the first`);
        continue;
      }
      standalone.set(name, file);
    }
    if (!(moduleTools[file] ?? []).length) {
      errors.push(`${TOOLS_DIR}/${file}: is registered by ${MCP_INDEX} but registers no tool at all`);
    }
  }

  const hostOnly = [];
  for (const tool of hostTools) {
    const mcpModule = standalone.get(tool.name) ?? null;
    if (tool.override) {
      if (!mcpModule) {
        errors.push(`${tool.name}: declared as an override host tool, but no registered ${TOOLS_DIR}/ ` +
          `module advertises it — registerHostTools() drops the override with a bare \`continue\`, ` +
          `so the tool disappears from the agent without an error`);
      }
      continue;
    }
    if (mcpModule) {
      errors.push(`${tool.name}: is a non-override host tool AND registered by ${TOOLS_DIR}/${mcpModule} — ` +
        `registerHostTools() throws "Duplicate tool name" and every agent boot fails`);
      continue;
    }
    hostOnly.push(tool.name);
  }

  const internal = new Set([...standalone.keys(), ...hostOnly]);

  // ── Stage 3: internal-only names are reviewed, and stay true ──────────────
  for (const name of hostProfileTools) {
    if (!hostTools.some((t) => t.name === name)) {
      errors.push(`${name}: named in HOST_TOOL_PROFILES but no host-tool factory provides it — ` +
        `the profile offers the model a tool that exists in neither catalog`);
      continue;
    }
    if (!internalOnly[name]) {
      errors.push(`${name}: reaches the in-process agent but never a standalone MCP host, and is not ` +
        `on the reviewed internal-only registry — the divergence needs a stated reason`);
    }
  }
  for (const [name, entry] of Object.entries(internalOnly)) {
    if (!hostProfileTools.includes(name)) {
      errors.push(`${name}: has a reviewed internal-only exception but is not in HOST_TOOL_PROFILES — ` +
        `registry entry is stale`);
      continue;
    }
    if (entry.hostOnly && standalone.has(name)) {
      errors.push(`${name}: exempt as host-only, but ${TOOLS_DIR}/${standalone.get(name)} now registers it — ` +
        `the exception's stated reason no longer holds and agent boot throws "Duplicate tool name"`);
    }
  }

  // ── Stage 4: no profile promises a tool neither catalog can serve ─────────
  for (const name of profileTools) {
    if (!internal.has(name)) {
      errors.push(`${name}: reachable through TOOL_PROFILES/FIRST_TURN_TOOLS but present in neither the ` +
        `standalone MCP catalog nor the host-tool catalog — the model is offered a phantom tool`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    catalog: {
      modules: registeredModules,
      standalone: [...standalone.keys()].sort(),
      hostOnly: hostOnly.sort(),
      internal: [...internal].sort(),
    },
  };
}

/** The real repo's tool registry. */
export async function checkToolRegistryContract() {
  const moduleFiles = listToolModules();
  const { moduleTools, noRegister } = await collectModuleTools(moduleFiles);
  return checkToolRegistry({
    moduleFiles,
    wiring: parseToolModuleWiring(readFileSync(`${ROOT}/${MCP_INDEX}`, "utf8")),
    moduleTools,
    noRegister,
    profileTools: profileToolNames(),
    hostProfileTools: [...new Set(Object.values(HOST_TOOL_PROFILES).flatMap((s) => [...s]))],
    hostTools: hostToolDescriptors(),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await checkToolRegistryContract(), null, 2));
}
