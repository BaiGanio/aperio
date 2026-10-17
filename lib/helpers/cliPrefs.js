// lib/helpers/cliPrefs.js — tiny persisted CLI preferences (#178).
// Currently holds only the `examples` toggle for the guided-tour help. Kept to
// two functions on purpose; seed at startup with readCliPrefs(), persist on
// toggle with writeCliPrefs(). Lives at 0600 under var/ like other local state.

import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { ensureSecureDir, writeSecureFile } from "./secureFile.js";

const DEFAULTS = { examples: true };

// Resolved at call time so tests (and relocations) can point APERIO_CLI_PREFS
// at a different file without re-importing the module.
function prefsPath() {
  return process.env.APERIO_CLI_PREFS
    ? resolve(process.env.APERIO_CLI_PREFS)
    : resolve(dirname(fileURLToPath(import.meta.url)), "../../var/cli-prefs.json");
}

// Read prefs, falling back to defaults on a missing or malformed file.
export function readCliPrefs() {
  try {
    const path = prefsPath();
    if (!existsSync(path)) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(readFileSync(path, "utf-8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

// Merge over defaults and persist. Best-effort: a write failure is non-fatal.
export function writeCliPrefs(prefs) {
  try {
    const path = prefsPath();
    ensureSecureDir(dirname(path));
    writeSecureFile(path, JSON.stringify({ ...DEFAULTS, ...prefs }, null, 2));
  } catch { /* prefs are a convenience, not critical state */ }
}
