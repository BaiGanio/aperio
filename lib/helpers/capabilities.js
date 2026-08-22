// Capability detection for optional skill dependencies (the "Extras" panel).
//
// Some skills (docx) have an advanced toolchain written in Python that needs
// extra host dependencies Aperio does not bundle — to honor "zero-config by
// default" we detect what's present and let the UI install/guide the rest:
//   - pip packages (lxml, defusedxml)  → auto-installable into a project venv
//   - system binaries (soffice, pdftoppm) → guided platform-specific command
//
// run_python_script prefers the venv interpreter (venvPython) so packages we
// install here are actually visible to the Python toolchain.

import { existsSync } from "fs";
import { execFileSync, execFile } from "child_process";
import { promisify } from "util";
import { resolve, join, dirname } from "path";
import { platform } from "os";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const VENV_DIR = join(ROOT, "var", "venv");
export const DOCX_REQUIREMENTS = join(ROOT, "skills", "docx", "requirements.txt");

const IS_WIN = platform() === "win32";

// Absolute path to the venv's python, or null if the venv isn't created yet.
export function venvPython() {
  const bin = IS_WIN
    ? join(VENV_DIR, "Scripts", "python.exe")
    : join(VENV_DIR, "bin", "python3");
  return existsSync(bin) ? bin : null;
}

// The interpreter run_python_script should spawn: venv if present, else system.
export function pythonInterpreter() {
  return venvPython() ?? "python3";
}

// Is `cmd` resolvable on PATH? Short-circuits with a hard timeout so a wedged
// PATH lookup can never hang capability detection.
function onPath(cmd) {
  try {
    execFileSync(IS_WIN ? "where" : "which", [cmd], { stdio: "ignore", timeout: 3000 });
    return true;
  } catch { return false; }
}

// Can `py` import every module in `mods`? Used to probe pip deps inside the venv.
function canImport(py, mods) {
  if (!py) return false;
  try {
    execFileSync(py, ["-c", `import ${mods.join(", ")}`], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch { return false; }
}

// Per-OS install command shown (with a copy button) for system binaries we
// cannot safely auto-install from a web request.
function installHint(binary) {
  const p = IS_WIN ? "win" : platform() === "darwin" ? "mac" : "linux";
  const hints = {
    python3: {
      mac:   "brew install python",
      linux: "sudo apt install python3 python3-venv  # or your distro's equivalent",
      win:   "Download from https://www.python.org/downloads/ (check 'Add to PATH')",
    },
    libreoffice: {
      mac:   "brew install --cask libreoffice",
      linux: "sudo apt install libreoffice  # or your distro's equivalent",
      win:   "Download from https://www.libreoffice.org/download/",
    },
    poppler: {
      mac:   "brew install poppler",
      linux: "sudo apt install poppler-utils  # or your distro's equivalent",
      win:   "choco install poppler  # or download poppler binaries and add to PATH",
    },
  };
  return hints[binary]?.[p] ?? "";
}

// Probe every dependency and group it into the docx capability tiers the UI
// renders. `auto: true` means the panel can install it (pip into venv);
// `auto: false` means it shows a guided command instead.
export function detectCapabilities() {
  const py        = pythonInterpreter();
  const hasPython = onPath("python3") || venvPython() !== null;
  const hasVenv   = venvPython() !== null;
  const hasPipPkgs = canImport(py, ["lxml", "defusedxml"]);
  const hasSoffice = onPath("soffice") || onPath("libreoffice");
  const hasPoppler = onPath("pdftoppm");

  return {
    platform: IS_WIN ? "win" : platform() === "darwin" ? "mac" : "linux",
    venv: hasVenv,
    tiers: [
      {
        id: "docx-create",
        label: "Create & read .docx",
        ready: true, // Node-based (docx npm lib) — always available, zero-config
        deps: [],
        note: "Built in — no extra dependencies.",
      },
      {
        id: "docx-edit",
        label: "Tracked changes, comments & validation",
        ready: hasPython && hasPipPkgs,
        deps: [
          { name: "python3",          present: hasPython,  auto: false, hint: hasPython ? "" : installHint("python3") },
          { name: "lxml, defusedxml", present: hasPipPkgs, auto: true,  hint: "" },
        ],
        note: "Python toolchain for editing existing Word documents.",
      },
      {
        id: "docx-render",
        label: "Accept changes & render to PDF/images",
        ready: hasSoffice && hasPoppler,
        deps: [
          { name: "libreoffice", present: hasSoffice, auto: false, hint: hasSoffice ? "" : installHint("libreoffice") },
          { name: "poppler",     present: hasPoppler, auto: false, hint: hasPoppler ? "" : installHint("poppler") },
        ],
        note: "System apps; install with the command shown, then re-check.",
      },
    ],
  };
}

// Auto-install the pip dependencies (lxml, defusedxml) into the project venv,
// creating the venv first if needed. This is the ONLY thing the panel installs
// for the user — system binaries are guided, never auto-run. Throws on failure
// with combined stdout/stderr so the route can surface it.
export async function installPipDeps() {
  if (!existsSync(VENV_DIR)) {
    await execFileAsync("python3", ["-m", "venv", VENV_DIR], { timeout: 60_000 });
  }
  const py = venvPython();
  if (!py) throw new Error("venv creation failed — python3 with the venv module is required on the host");

  // Upgrade pip first (old pip can fail to build lxml wheels), then install.
  await execFileAsync(py, ["-m", "pip", "install", "--upgrade", "pip"], { timeout: 120_000 });
  const { stdout, stderr } = await execFileAsync(
    py, ["-m", "pip", "install", "-r", DOCX_REQUIREMENTS], { timeout: 300_000 }
  );
  return { ok: true, log: `${stdout}\n${stderr}`.trim() };
}
