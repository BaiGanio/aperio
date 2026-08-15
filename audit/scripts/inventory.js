// audit/scripts/inventory.js
//
// T1 baseline inventory for the continuous-audit program
// (trash/plans/aperio-continuous-audit/aperio-continuous-audit.md, Step 1).
// Generates a reproducible, checked-in-script snapshot of repo shape instead
// of a model-typed one. Run: node audit/scripts/inventory.js
//
// Covered by tests/unit/audit-inventory.test.js (T1.1).

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "../../lib/config.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function listFiles(dir, { recursive = true, suffix = ".js" } = {}) {
  let entries;
  try {
    entries = readdirSync(join(ROOT, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  let out = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (recursive) out = out.concat(listFiles(rel, { recursive, suffix }));
      continue;
    }
    if (!suffix || entry.name.endsWith(suffix)) out.push(rel);
  }
  return out;
}

function baseNames(paths, prefix) {
  return paths.map((p) => p.slice(prefix.length + 1)).sort();
}

function countByArea(areas, opts) {
  const by_area = {};
  let total = 0;
  for (const [label, dir] of Object.entries(areas)) {
    const n = listFiles(dir, opts).length;
    by_area[label] = n;
    total += n;
  }
  return { total, by_area };
}

function repository() {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const commit = git(["rev-parse", "HEAD"]);
  const dirty_paths = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  return { branch, commit, dirty: dirty_paths.length > 0, dirty_paths };
}

function environment() {
  return {
    node: process.version,
    npm: execFileSync("npm", ["--version"], { cwd: ROOT, encoding: "utf8" }).trim(),
  };
}

function providerList() {
  return [...(CONFIG.find((c) => c.key === "AI_PROVIDER")?.options ?? [])].sort();
}

function configKeys() {
  const keys = CONFIG.map((c) => c.key).sort();
  return { count: keys.length, keys };
}

function migrations() {
  const pg = baseNames(listFiles("db/migrations", { recursive: false, suffix: ".sql" }), "db/migrations");
  const sqlite = baseNames(
    listFiles("db/migrations-sqlite", { recursive: false, suffix: ".sql" }),
    "db/migrations-sqlite"
  );
  return {
    migrations_postgres: pg,
    migrations_sqlite: sqlite,
    migration_count_postgres: pg.length,
    migration_count_sqlite: sqlite.length,
    migration_parity: JSON.stringify(pg) === JSON.stringify(sqlite),
  };
}

function locales() {
  const codes = baseNames(
    listFiles("public/locales", { recursive: false, suffix: ".json" }),
    "public/locales"
  ).map((f) => f.replace(/\.json$/, ""));
  return { count: codes.length, codes };
}

export function generateInventory() {
  return {
    $schema: "aperio-audit-inventory-v1",
    observed_at: new Date().toISOString(),
    repository: repository(),
    environment: environment(),
    source_files: countByArea({
      lib: "lib",
      mcp: "mcp",
      db: "db",
      publicScripts: "public/scripts",
      skills: "skills",
    }),
    test_files: countByArea(
      {
        unit: "tests/unit",
        integration: "tests/integration",
        e2e: "tests/e2e",
        harness: "tests/harness",
        docint: "tests/docint",
      },
      { suffix: ".test.js" }
    ),
    providers: providerList(),
    routes: baseNames(listFiles("lib/routes", { recursive: false }), "lib/routes"),
    mcp_tools: baseNames(listFiles("mcp/tools", { recursive: false }), "mcp/tools"),
    database: migrations(),
    locales: locales(),
    config: configKeys(),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(generateInventory(), null, 2));
}
