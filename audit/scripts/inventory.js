#!/usr/bin/env node

// audit/scripts/inventory.js
// Reproducible, deterministic repository inventory for Aperio Continuous Audit.
// Use: node audit/scripts/inventory.js [rootDir]
//
// Outputs a normalized JSON inventory to stdout.
// Byte-identical across repeated runs except for the `observed_at` timestamp.
// Pass `--no-timestamp` to omit the timestamp for comparison purposes.

import { readdirSync, statSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execSync } from "node:child_process";

function sorted(a) {
  return [...a].sort((a, b) => a.localeCompare(b, "en"));
}

function run(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

function findFiles(root, patternFn) {
  const results = [];
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name.startsWith(".") || e.name === "coverage") continue;
        walk(full);
      } else if (e.isFile() && patternFn(e.name)) {
        results.push(full);
      }
    }
  }
  walk(root);
  return results;
}

function countByDir(root, patternFn) {
  const files = findFiles(root, patternFn);
  const byDir = {};
  for (const f of files) {
    const dir = join(root, f.replace(root, "").split("/").filter(Boolean).slice(0, -1).join("/"));
    const key = dir.replace(root, ".") || ".";
    byDir[key] = (byDir[key] || 0) + 1;
  }
  return byDir;
}

function listDir(path) {
  try {
    return readdirSync(path).filter((e) => !e.startsWith("."));
  } catch {
    return [];
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const flags = { noTimestamp: false, rootDir: null };
  for (const a of args) {
    if (a === "--no-timestamp") { flags.noTimestamp = true; }
    else if (!a.startsWith("--")) { flags.rootDir = a; }
  }
  return flags;
}

async function inventory(rootDir, { includeTimestamp = true } = {}) {
  rootDir = resolve(rootDir || process.cwd());

  // ── Git state ──────────────────────────────────────────────────────────────
  const branch = run("git branch --show-current", rootDir);
  const sha = run("git rev-parse HEAD", rootDir);
  const dirtyShort = run("git status --short", rootDir);
  const dirtyLines = dirtyShort ? dirtyShort.split("\n").filter(Boolean) : [];

  // ── Versions ───────────────────────────────────────────────────────────────
  const nodeVersion = run("node --version", rootDir);
  const npmVersion = run("npm --version", rootDir);

  // ── Source files ───────────────────────────────────────────────────────────
  const libJsFiles = findFiles(join(rootDir, "lib"), (n) => n.endsWith(".js"));
  const mcpJsFiles = findFiles(join(rootDir, "mcp"), (n) => n.endsWith(".js"));
  const dbJsFiles  = findFiles(join(rootDir, "db"),  (n) => n.endsWith(".js") && !n.includes("node_modules"));
  const publicScripts = findFiles(join(rootDir, "public", "scripts"), (n) => n.endsWith(".js"));
  const skillsFiles   = findFiles(join(rootDir, "skills"), (n) => n.endsWith(".js") || n.endsWith(".md"));

  const sourceCounts = {
    lib:       libJsFiles.length,
    mcp:       mcpJsFiles.length,
    db:        dbJsFiles.length,
    publicScripts: publicScripts.length,
    skills:    skillsFiles.length,
  };

  // ── Test files ─────────────────────────────────────────────────────────────
  const testFiles = findFiles(join(rootDir, "tests"), (n) => n.endsWith(".test.js"));
  const testCounts = {
    total:  testFiles.length,
    byDir:  countByDir(join(rootDir, "tests"), (n) => n.endsWith(".test.js")),
  };

  // ── Providers ──────────────────────────────────────────────────────────────
  const providerDir = join(rootDir, "lib", "agent", "providers");
  const providerNames = existsSync(providerDir)
    ? sorted(listDir(providerDir).filter((f) => f.endsWith(".js")).map((f) => f.replace(/\.js$/, "")))
    : [];

  // ── Routes ─────────────────────────────────────────────────────────────────
  const routeDir = join(rootDir, "lib", "routes");
  const routeFiles = existsSync(routeDir)
    ? sorted(listDir(routeDir).filter((f) => f.endsWith(".js")))
    : [];

  // ── MCP tools ──────────────────────────────────────────────────────────────
  const mcpToolDir = join(rootDir, "mcp", "tools");
  const mcpToolDirs = existsSync(mcpToolDir)
    ? sorted(listDir(mcpToolDir).filter((f) => {
        const full = join(mcpToolDir, f);
        return statSync(full).isDirectory() || (f.endsWith(".js") && f !== "index.js");
      }))
    : [];

  // ── DB migrations ──────────────────────────────────────────────────────────
  const pgMigrations  = existsSync(join(rootDir, "db", "migrations"))
    ? sorted(listDir(join(rootDir, "db", "migrations")).filter((f) => f.endsWith(".sql")))
    : [];
  const sqliteMigrations = existsSync(join(rootDir, "db", "migrations-sqlite"))
    ? sorted(listDir(join(rootDir, "db", "migrations-sqlite")).filter((f) => f.endsWith(".sql")))
    : [];

  // ── DB source files ────────────────────────────────────────────────────────
  const dbSourceFiles = sorted(
    listDir(join(rootDir, "db")).filter((f) => f.endsWith(".js"))
      .concat(listDir(join(rootDir, "db", "sqlite")).filter((f) => f.endsWith(".js")).map((f) => `sqlite/${f}`))
      .concat(listDir(join(rootDir, "db", "postgres")).filter((f) => f.endsWith(".js")).map((f) => `postgres/${f}`))
  );

  // ── Locales ────────────────────────────────────────────────────────────────
  const localeDir = join(rootDir, "public", "locales");
  const localeFiles = existsSync(localeDir)
    ? sorted(listDir(localeDir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")))
    : [];

  // ── Assembly ───────────────────────────────────────────────────────────────
  const result = {
    $schema: "aperio-audit-inventory-v1",
    ...(includeTimestamp ? { observed_at: new Date().toISOString() } : {}),
    repository: {
      branch: branch ?? "unknown",
      commit: sha ?? "unknown",
      dirty: dirtyLines.length > 0,
      dirty_paths: dirtyLines,
    },
    environment: {
      node: nodeVersion,
      npm: npmVersion,
    },
    source_files: {
      total: libJsFiles.length + mcpJsFiles.length + dbJsFiles.length + publicScripts.length + skillsFiles.length,
      by_area: sourceCounts,
    },
    test_files: testCounts,
    providers: providerNames,
    routes: routeFiles,
    mcp_tools: mcpToolDirs,
    database: {
      migrations_postgres: pgMigrations,
      migrations_sqlite: sqliteMigrations,
      migration_count_postgres: pgMigrations.length,
      migration_count_sqlite: sqliteMigrations.length,
      migration_parity: pgMigrations.length === sqliteMigrations.length,
      source_files: dbSourceFiles,
    },
    locales: {
      count: localeFiles.length,
      codes: localeFiles,
    },
  };

  return result;
}

const flags = parseArgs();
const rootDir = flags.rootDir || process.cwd();
inventory(rootDir, { includeTimestamp: !flags.noTimestamp })
  .then((inv) => {
    process.stdout.write(JSON.stringify(inv, null, 2) + "\n");
  })
  .catch((err) => {
    console.error("Inventory error:", err.message);
    process.exit(1);
  });
