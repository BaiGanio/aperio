// audit/scripts/memory-contract.js
//
// T2.3 — MCP ctx/handler coherence for the A13 (memory, wiki, embeddings)
// domain (aperio-continuous-audit.md Step 2, T2.3). Scoped to the memory/wiki
// handler family rather than every MCP tool: mcp/index.js's createContext()
// return shape is the single source of truth every registered tool depends
// on (AGENTS.md's "mcp/index.js — MCP Tool Context (ctx)" fragile zone), and
// a handler reading a ctx field createContext never supplies fails silently
// with `undefined` rather than a registration error — exactly T2.3's
// "fixture tool reads a ctx field not supplied by createContext" case.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MCP_INDEX = "mcp/index.js";
const HANDLER_DIRS = ["lib/handlers/memory", "lib/handlers/wiki"];

// createContext() reads several fields off `opts`/module state before
// building its return object, so those names would be false positives if
// they were parsed out of the same regex sweep as the return block. Declared
// explicitly instead of parsed, since createContext's return statement is a
// single, stable, hand-reviewable literal (unlike the ~280-callsite env-read
// sweep in config-contract.js, where static parsing was the only option).
export function knownCtxFields() {
  const src = readFileSync(`${ROOT}/${MCP_INDEX}`, "utf8");
  const match = src.match(/async function createContext[\s\S]*?\n\}/);
  if (!match) throw new Error(`could not locate createContext() in ${MCP_INDEX}`);
  const body = match[0];
  const returnBlock = body.match(/return\s*\{([\s\S]*)\n\};?\s*$/);
  if (!returnBlock) throw new Error(`could not locate createContext()'s return object in ${MCP_INDEX}`);
  const fields = new Set();
  // Matches a top-level `key,` / `key:` / `key(` (getter shorthand) at the
  // start of a line inside the return object literal.
  const re = /^\s+([A-Za-z_][A-Za-z0-9_]*)\s*[,:(]/gm;
  let m;
  while ((m = re.exec(returnBlock[1]))) fields.add(m[1]);
  return fields;
}

// Both access styles appear in real handlers: `ctx.field` direct reads and
// `const { a, b } = ctx;` destructuring (with an optional `x: renamed` alias,
// where the CTX field is the left-hand name, not the local variable).
export function ctxFieldsUsed(source) {
  const fields = new Set();
  const directRe = /\bctx\.([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = directRe.exec(source))) fields.add(m[1]);

  const destructureRe = /(?:const|let)\s*\{([^}]+)\}\s*=\s*ctx\b/g;
  while ((m = destructureRe.exec(source))) {
    for (const part of m[1].split(",")) {
      const name = part.split(":")[0].trim().replace(/=.*/, "").trim();
      if (name) fields.add(name);
    }
  }
  return fields;
}

function listHandlerFiles() {
  return HANDLER_DIRS.flatMap((dir) =>
    execFileSync("git", ["ls-files", dir], { cwd: ROOT, encoding: "utf8" }).split("\n").filter((f) => f.endsWith(".js"))
  );
}

export function checkMemoryCtxContract({ known = knownCtxFields(), files = listHandlerFiles() } = {}) {
  const violations = [];
  for (const rel of files) {
    let source;
    try {
      source = readFileSync(`${ROOT}/${rel}`, "utf8");
    } catch {
      continue;
    }
    for (const field of ctxFieldsUsed(source)) {
      if (!known.has(field)) violations.push({ file: rel, field });
    }
  }
  return { ok: violations.length === 0, violations, knownFields: [...known].sort() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(checkMemoryCtxContract(), null, 2));
}
