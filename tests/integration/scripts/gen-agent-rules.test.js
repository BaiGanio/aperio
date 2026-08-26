// tests/integration/scripts/gen-agent-rules.test.js
// WS3 of the ponytail-borrow epic (#285): one canonical memory-discipline
// ruleset (id/agent-rules/aperio-memory.md) fans out to per-platform adapters
// under integrations/agent-rules/, and nothing is allowed to drift — not the
// adapters from the canonical file, not the canonical file from the tool
// surface it describes.
//
// Groups map 1:1 to trash/plans/ponytail-borrow/ponytail-borrow-ws3-tests.md.

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = join(ROOT, "scripts", "gen-agent-rules.js");
const CANON = join(ROOT, "id", "agent-rules", "aperio-memory.md");
const OUT = join(ROOT, "integrations", "agent-rules");
const WORKFLOW = join(ROOT, ".github", "workflows", "ci.generated-artifacts.yml");
const SKILL = join(ROOT, "skills", "memory-protocol", "SKILL.md");

// Relative paths of the three adapters, as written under any output dir.
const ADAPTERS = [
  "AGENTS.snippet.md",
  join("cursor", "aperio-memory.mdc"),
  join("claude-code", "aperio-memory", "SKILL.md"),
];

const run = (args, dir) =>
  spawnSync(process.execPath, [SCRIPT, ...(dir ? ["--out-dir", dir] : []), ...args], { encoding: "utf8" });

// Folded to LF, matching the generator. Git checks this repo out with CRLF on
// Windows, so a raw read would make the byte-compares below assert on checkout
// policy rather than on content drift — the thing these tests actually guard.
const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

/** Frontmatter body split: everything after a leading `---` fenced block. */
function bodyOf(text) {
  const m = text.match(/^---\n[\s\S]*?\n---\n/);
  return m ? text.slice(m[0].length) : text;
}

/** Every tool name registered under mcp/tools/, across both registration shapes. */
function registeredToolNames() {
  const names = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!entry.endsWith(".js")) continue;
      const src = readFileSync(p, "utf8");
      // memory.js / wiki.js style: { name: "recall", ... }
      for (const m of src.matchAll(/name:\s*"([a-z][a-z0-9_]*)"/g)) names.add(m[1]);
      // files.js style: server.tool("read_file", …) — bare positional string
      for (const m of src.matchAll(/^\s*"([a-z][a-z0-9_]*)",\s*$/gm)) names.add(m[1]);
    }
  };
  walk(join(ROOT, "mcp", "tools"));
  return names;
}

// Snake_case identifiers that are tool *parameters*, not tools. Backticking one
// of these in the canonical doc is legitimate; extend this set rather than
// loosening the check if the doctrine starts documenting more parameters.
const KNOWN_PARAMS = new Set(["search_mode", "as_of", "source_memory_ids", "source_self_memory_ids", "body_md", "allow_stale"]);

/**
 * Tool citations in the canonical doc: backticked tokens that carry an
 * underscore are unambiguously tool names (`propose_memory`, `self_remember`).
 * Single-word prose in backticks (`fact`, `.env`) is deliberately not matched —
 * this test hunts renames and inventions, not vocabulary.
 */
function citedToolNames(text) {
  const cited = new Set();
  for (const m of text.matchAll(/`([a-z][a-z0-9]*_[a-z0-9_]*)`/g)) {
    if (!KNOWN_PARAMS.has(m[1])) cited.add(m[1]);
  }
  return cited;
}

// The doctrine is incomplete if it never mentions these — the reach of the
// ruleset is the point, so the coverage is asserted, not assumed.
const CORE_TOOLS = ["recall", "remember", "propose_memory", "update_memory", "forget", "wiki_get", "self_remember"];

describe("gen-agent-rules (#285 WS3)", () => {
  const scratch = [];
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aperio-genrules-"));
    scratch.push(dir);
  });
  after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

  // ── G1 — adapter production ────────────────────────────────────────────────
  describe("G1: adapter production", () => {
    test("G1.1: writes all three adapters into --out-dir, creating nested dirs", () => {
      const nested = join(dir, "deep", "not", "created");
      const r = run([], nested);
      assert.equal(r.status, 0, r.stderr);
      for (const rel of ADAPTERS) {
        const p = join(nested, rel);
        assert.ok(existsSync(p), `${rel} not written`);
        assert.ok(read(p).trim().length > 0, `${rel} is empty`);
      }
    });

    test("G1.2: generation is idempotent — a second run is byte-identical", () => {
      run([], dir);
      const first = ADAPTERS.map((rel) => read(join(dir, rel)));
      run([], dir);
      ADAPTERS.forEach((rel, i) => {
        assert.equal(read(join(dir, rel)), first[i], `${rel} changed on regeneration`);
      });
    });
  });

  // ── G2 — adapter content ───────────────────────────────────────────────────
  describe("G2: adapter content", () => {
    beforeEach(() => { run([], dir); });

    test("G2.1: every adapter announces it is generated and names its source", () => {
      for (const rel of ADAPTERS) {
        const text = read(join(dir, rel));
        assert.match(text, /AUTO-GENERATED/, `${rel} missing AUTO-GENERATED banner`);
        assert.ok(text.includes("id/agent-rules/aperio-memory.md"),
          `${rel} does not name the canonical source`);
        assert.ok(text.includes("gen:agent-rules"),
          `${rel} does not name the regeneration command`);
      }
    });

    test("G2.2: every adapter carries the load-bearing rules", () => {
      for (const rel of ADAPTERS) {
        const text = read(join(dir, rel));
        for (const tool of CORE_TOOLS) {
          assert.ok(text.includes(tool), `${rel} is missing the \`${tool}\` rule`);
        }
      }
    });

    test("G2.3: every adapter attributes ponytail (MIT)", () => {
      for (const rel of ADAPTERS) {
        const text = read(join(dir, rel));
        assert.match(text, /ponytail/i, `${rel} is missing ponytail attribution`);
        assert.match(text, /MIT/, `${rel} is missing the MIT license note`);
      }
    });

    test("G2.4: Cursor adapter opens with valid .mdc frontmatter", () => {
      const text = read(join(dir, "cursor", "aperio-memory.mdc"));
      const m = text.match(/^---\n([\s\S]*?)\n---\n/);
      assert.ok(m, "cursor adapter has no frontmatter block");
      assert.match(m[1], /^description:/m);
      assert.match(m[1], /^alwaysApply:/m);
    });

    test("G2.5: Claude Code adapter opens with house skill frontmatter", () => {
      const text = read(join(dir, "claude-code", "aperio-memory", "SKILL.md"));
      const m = text.match(/^---\n([\s\S]*?)\n---\n/);
      assert.ok(m, "claude-code adapter has no frontmatter block");
      assert.match(m[1], /^name:/m);
      assert.match(m[1], /^description:/m);
      assert.match(m[1], /^\s+keywords:/m);
      assert.match(m[1], /^\s+load:/m);
    });

    test("G2.6: AGENTS snippet has no frontmatter — it is pasted into an existing file", () => {
      const text = read(join(dir, "AGENTS.snippet.md"));
      assert.ok(!/^---\n/.test(text), "AGENTS.snippet.md must not open with frontmatter");
    });
  });

  // ── G3 — drift detection ───────────────────────────────────────────────────
  describe("G3: drift detection", () => {
    beforeEach(() => { run([], dir); });

    test("G3.1: --check exits 0 immediately after a fresh generation", () => {
      assert.equal(run(["--check"], dir).status, 0);
    });

    test("G3.2: drift in ANY single adapter is caught", () => {
      for (const rel of ADAPTERS) {
        const p = join(dir, rel);
        const orig = read(p);
        writeFileSync(p, orig + "\n");           // trailing newline only — byte compare, not trimmed
        assert.equal(run(["--check"], dir).status, 1, `--check missed drift in ${rel}`);
        writeFileSync(p, orig);
        assert.equal(run(["--check"], dir).status, 0, `--check stayed red after restoring ${rel}`);
      }
    });

    test("G3.3: a missing adapter counts as stale", () => {
      const p = join(dir, ADAPTERS[0]);
      const orig = read(p);
      rmSync(p);
      assert.equal(run(["--check"], dir).status, 1);
      writeFileSync(p, orig);
      assert.equal(run(["--check"], dir).status, 0);
    });

    test("G3.4: failure names the file and the fix", () => {
      const p = join(dir, ADAPTERS[1]);
      writeFileSync(p, read(p) + "# drift\n");
      const r = run(["--check"], dir);
      assert.equal(r.status, 1);
      const out = `${r.stdout}${r.stderr}`;
      assert.match(out, /aperio-memory\.mdc/);
      assert.match(out, /gen:agent-rules/);
    });
  });

  // ── G4 — canonical doc integrity ───────────────────────────────────────────
  describe("G4: canonical doc integrity", () => {
    test("G4.1: the canonical ruleset exists", () => {
      assert.ok(existsSync(CANON), "id/agent-rules/aperio-memory.md is missing");
    });

    test("G4.2: body stays within the 80-line portable budget", () => {
      const lines = bodyOf(read(CANON)).split("\n").filter((l, i, a) => !(i === a.length - 1 && l === ""));
      assert.ok(lines.length <= 80,
        `canonical body is ${lines.length} lines; the portable budget is 80`);
    });

    test("G4.3: every tool it cites is actually registered under mcp/tools/", () => {
      const registered = registeredToolNames();
      assert.ok(registered.size > 20, "tool-name extraction found suspiciously few tools");
      const cited = citedToolNames(read(CANON));
      assert.ok(cited.size > 0, "canonical doc cites no tools at all");
      for (const name of cited) {
        assert.ok(registered.has(name),
          `canonical doc cites \`${name}\`, which is not registered under mcp/tools/. ` +
          `If it is a tool parameter rather than a tool, add it to KNOWN_PARAMS in this file.`);
      }
    });

    test("G4.4: the doctrine covers the core memory surface", () => {
      const text = read(CANON);
      for (const tool of CORE_TOOLS) {
        assert.ok(text.includes(tool), `canonical doc never mentions \`${tool}\``);
      }
    });

    test("G4.5: never-store rules cover credentials explicitly", () => {
      const text = read(CANON).toLowerCase();
      assert.ok(/token|api key|password|secret|credential/.test(text),
        "a memory-discipline ruleset that never mentions credentials is incomplete");
    });
  });

  // ── G5 — repo freshness ────────────────────────────────────────────────────
  describe("G5: repo freshness", () => {
    test("G5.1: committed adapters byte-match a fresh build", () => {
      const r = run([], dir);
      assert.equal(r.status, 0, r.stderr);
      for (const rel of ADAPTERS) {
        const committed = join(OUT, rel);
        assert.ok(existsSync(committed),
          `${relative(ROOT, committed)} is not committed — run \`npm run gen:agent-rules\``);
        assert.equal(read(committed), read(join(dir, rel)),
          `${relative(ROOT, committed)} is stale — run \`npm run gen:agent-rules\``);
      }
    });

    test("G5.2: in-repo --check passes on a clean tree", () => {
      const r = run(["--check"], null);
      assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    });
  });

  // ── G6 — CI gate wiring ────────────────────────────────────────────────────
  describe("G6: CI gate wiring", () => {
    test("G6.1: the workflow exists and runs both generator checks", () => {
      assert.ok(existsSync(WORKFLOW), "ci.generated-artifacts.yml is missing");
      const text = read(WORKFLOW);
      assert.ok(text.includes("gen:agent-rules:check"), "workflow does not run gen:agent-rules:check");
      assert.ok(text.includes("gen:env:check"), "workflow does not run gen:env:check");
    });

    test("G6.2: it triggers on push and pull_request, not only workflow_dispatch", () => {
      const text = read(WORKFLOW);
      assert.match(text, /^\s*push:/m, "workflow has no push trigger");
      assert.match(text, /^\s*pull_request:/m, "workflow has no pull_request trigger");
    });

    test("G6.3: every action is pinned to a commit SHA", () => {
      const text = read(WORKFLOW);
      const uses = [...text.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
      assert.ok(uses.length > 0, "workflow uses no actions at all");
      for (const u of uses) {
        assert.match(u, /@[0-9a-f]{40}$/, `${u} is not pinned to a 40-char SHA`);
      }
    });
  });

  // ── G7 — cross-link ────────────────────────────────────────────────────────
  describe("G7: cross-link", () => {
    test("G7.1: memory-protocol skill points at the canonical ruleset, in the body", () => {
      const text = read(SKILL);
      assert.ok(text.includes("id/agent-rules/aperio-memory.md"),
        "memory-protocol/SKILL.md does not link the canonical ruleset");
      assert.ok(bodyOf(text).includes("id/agent-rules/aperio-memory.md"),
        "the link must live in the body, not inside the frontmatter block");
    });
  });
});
