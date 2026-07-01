// lib/tools/schemaCheck.js
// Schema-aware tool-call instrumentation (measure-first).
//
// The harness already repairs malformed JSON syntax (executor.parseArgs). This
// layer sits one level up: it checks parsed args against the tool's *schema* and
// records the mismatch classes that weak/open models actually produce — sending
// null/empty for optional params, a string where an array is expected, a
// hallucinated argument name, or a missing required field. The point (for now)
// is measurement: capture real events per model+tool to a ledger so repair rules
// can be designed from data rather than guessed. hintFromIssues turns the same
// findings into a precise correction the model can act on, used only when a call
// has actually failed (and never for destructive tools, which stay strict).
//
// Inspired by the "validate-then-repair" harness idea: open models look bad at
// tool calling mostly because the harness hands back generic errors instead of
// pointed fixes.

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const LEDGER_DIR  = "var/toolrepair";
const LEDGER_FILE = join(LEDGER_DIR, "events.tsv");
const HEADER = ["ts", "model", "tool", "kind", "param", "expected", "received", "call_errored"].join("\t");

function jsType(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v; // object | string | number | boolean | undefined
}

// number/integer are interchangeable for our purposes; everything else must match.
function typeMatches(expected, actual) {
  if (!expected) return true; // schema didn't pin a type — nothing to check
  if (expected === actual) return true;
  if ((expected === "number" || expected === "integer") && actual === "number") return true;
  return false;
}

// schema: the normalized { type, properties: { k: { type } }, required: [] } shape
// produced by zodToJsonSchema. Returns an array of issue objects; [] when the
// args satisfy the schema (or the schema is too loose to judge).
export function checkArgs(args, schema) {
  const props = schema?.properties;
  if (!props || typeof args !== "object" || args === null || Array.isArray(args)) return [];
  const required = Array.isArray(schema.required) ? schema.required : [];
  const issues = [];

  for (const req of required) {
    if (args[req] === undefined || args[req] === null) {
      issues.push({ kind: "missing_required", param: req, expected: props[req]?.type, received: jsType(args[req]) });
    }
  }

  for (const [k, v] of Object.entries(args)) {
    if (k === "__parse_error__") continue;
    if (!(k in props)) { issues.push({ kind: "unknown_param", param: k, expected: undefined, received: jsType(v) }); continue; }
    const expected = props[k].type;
    const isRequired = required.includes(k);
    if ((v === null || v === "") && !isRequired) { issues.push({ kind: "null_optional", param: k, expected, received: jsType(v) }); continue; }
    if (v === null) continue; // a required null is already reported above
    const actual = jsType(v);
    if (!typeMatches(expected, actual)) issues.push({ kind: "type_mismatch", param: k, expected, received: actual });
  }

  return issues;
}

// A pointed, model-facing correction for the issues found. Returns null when
// there is nothing to say. Kept terse — it is appended to a failed call's error.
export function hintFromIssues(toolName, issues) {
  if (!issues?.length) return null;
  const parts = issues.map((i) => {
    switch (i.kind) {
      case "missing_required": return `required param \`${i.param}\` (${i.expected ?? "value"}) is missing — add it`;
      case "type_mismatch":    return `param \`${i.param}\` expects ${i.expected}, you sent ${i.received}` + (i.expected === "array" ? ` — wrap it as [${i.received === "string" ? '"…"' : "…"}]` : "");
      case "null_optional":    return `optional param \`${i.param}\` was sent as ${i.received} — omit it instead of sending empty`;
      case "unknown_param":    return `\`${i.param}\` is not a parameter of this tool — remove it`;
      default:                 return null;
    }
  }).filter(Boolean);
  if (!parts.length) return null;
  return `⚠️ Argument check for \`${toolName}\`: ${parts.join("; ")}. Fix and call again.`;
}

// Append one TSV row per issue. Best-effort and silent under test — must never
// throw into the tool-call path.
export function logToolRepairEvents({ model, tool, issues, callErrored }) {
  if (process.env.NODE_ENV === "test" || !issues?.length) return;
  try {
    mkdirSync(LEDGER_DIR, { recursive: true });
    const isNew = !existsSync(LEDGER_FILE);
    const ts = new Date().toISOString();
    const rows = issues.map((i) =>
      [ts, model ?? "", tool, i.kind, i.param, i.expected ?? "", i.received ?? "", callErrored ? "1" : "0"].join("\t")
    );
    appendFileSync(LEDGER_FILE, (isNew ? HEADER + "\n" : "") + rows.join("\n") + "\n");
  } catch { /* best-effort: instrumentation must never break a tool call */ }
}
