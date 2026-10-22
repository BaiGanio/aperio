// Per-turn lifecycle state for script-built artifacts.
//
// Artifact existence is necessary but not sufficient for a truthful success
// claim: a repaired generator must be executed again, and a PPTX must be
// verified after the generator revision that produced it. This tracker keeps
// that ordering invariant out of provider prompts and final-answer wording.

const SCRIPT_EXT = /\.(?:js|cjs|mjs|py)$/i;

function succeeded(result) {
  return typeof result === "string" && !result.startsWith("❌");
}

export function createArtifactLifecycle({ scratchDir, existsSync, statSync, basename }) {
  const scripts = new Map();
  const verifiedPptx = new Map();

  function isScratchScript(path) {
    if (!scratchDir || typeof path !== "string" || !SCRIPT_EXT.test(path)) return false;
    const root = scratchDir.replace(/[\\/]+$/, "").replace(/\\/g, "/");
    const normalized = path.replace(/\\/g, "/");
    return normalized.startsWith(`${root}/`);
  }

  function scriptState(path) {
    let state = scripts.get(path);
    if (!state) {
      state = { revision: 0, executedRevision: null, executionOk: false };
      scripts.set(path, state);
    }
    return state;
  }

  function recordToolResult(name, args, result) {
    if ((name === "write_file" || name === "edit_file" || name === "append_file")
        && succeeded(result) && !/\bToken:\s*(?:wr|iss|del|db|idx)_[a-z0-9]+\b/i.test(result)) {
      const path = args?.path;
      if (isScratchScript(path)) {
        const state = scriptState(path);
        state.revision++;
        state.executionOk = false;
      }
      return;
    }

    if (name !== "run_node_script" && name !== "run_python_script") return;
    const path = args?.script;
    if (!isScratchScript(path)) return;
    const state = scriptState(path);
    state.executedRevision = state.revision;
    state.executionOk = succeeded(result);
  }

  function recordPptxVerification(info) {
    if (info?.action !== "verify" || typeof info.path !== "string" || !/\.pptx$/i.test(info.path)) return;
    if (!existsSync(info.path)) return;
    verifiedPptx.set(basename(info.path), {
      path: info.path,
      size: statSync(info.path).size,
      scriptRevisions: new Map([...scripts].map(([path, state]) => [path, state.revision])),
    });
  }

  function inspectPptx(path) {
    if (!existsSync(path)) return { ok: false, reason: "missing" };
    // Do not demand fresh verification merely because an older deck is
    // mentioned. The stricter gate applies only when this turn performed a
    // script-based artifact build or repair.
    if (!scripts.size) return { ok: true };

    const verification = verifiedPptx.get(basename(path));
    if (!verification || !existsSync(verification.path)) {
      const pending = [...scripts.values()].some(
        state => state.executedRevision !== state.revision || !state.executionOk,
      );
      return { ok: false, reason: pending ? "latest-script-not-executed" : "unverified" };
    }
    if (statSync(verification.path).size !== verification.size) {
      return { ok: false, reason: "verification-stale" };
    }
    for (const [scriptPath, state] of scripts) {
      const verifiedRevision = verification.scriptRevisions.get(scriptPath);
      if (verifiedRevision !== undefined && state.revision !== verifiedRevision) {
        return {
          ok: false,
          reason: state.executedRevision === state.revision && state.executionOk
            ? "verification-stale"
            : "latest-script-not-executed",
        };
      }
    }
    return { ok: true };
  }

  return { recordToolResult, recordPptxVerification, inspectPptx };
}
