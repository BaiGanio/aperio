// lib/agent/tool-hooks.js — Tool-call wrapping, failure budgeting, artifact surfacing.
//
// Extracted from lib/agent/index.js:runAgentLoop. This module encapsulates the
// tool-call hook (callToolHooked) and its helper functions (surfaceArtifact,
// flushDownloadCards, surfaceScratchArtifacts, recordFailure, budgetMessage,
// verifyFileClaims) that were previously ~360 lines of nested closures inside
// the agent loop.
//
// Architecture:
//   createToolHooks(deps)        — one-time factory, captures stable dependencies
//     → makeTurnHooks(emitter, turnStartMs)  — per-turn factory, creates fresh
//       mutable state
//       → { callToolHooked, surfaceArtifact, surfaceScratchArtifacts,
//           flushDownloadCards, verifyFileClaims, toolSeq, failures }

import { createLifecycleRunner } from "./middleware.js";
import {
  createToolSafetyMiddleware,
  TOOL_FAILURE_BUDGET,
  TOOL_SAFETY_MIDDLEWARE_NAMES,
} from "./tool-safety-middleware.js";
import { createToolResultOffloadMiddleware } from "./model-context-middleware.js";
import { isMeaningfulWorkflowTool } from "./workflow-detection.js";
import { resolveScopedSearchPath, selectSearchScope } from "./search-scopes.js";
import { createArtifactLifecycle } from "./artifact-lifecycle.js";

const DOWNLOADABLE_EXT = /\.(pptx|pdf|docx|xlsx|xls|csv|tsv|html?|svg|md|txt|text|json|xml)$/i;
// Source-code deliverables (a developer asking "generate me a TypeScript file").
// Surfaced as cards too, but ONLY at end of turn and ONLY if the file was not
// executed this turn — see surfaceCodeArtifacts. Extension cannot tell a
// requested .js/.py deliverable from a generator script the model runs to build
// a PDF/pptx; execution can, so the runner languages (js/cjs/mjs/py) are
// excluded by having been run, not by their extension.
const CODE_EXT = /\.(ts|tsx|js|jsx|cjs|mjs|py|cs|go|java|rb|rs|cpp|cc|c|h|hpp|kt|swift|php|scala|sql|sh|bash|css|scss|less|vue|svelte|yaml|yml|toml)$/i;
const RUNNER_SCRIPT_EXT = /\.(?:js|cjs|mjs|py)$/i;
const IMAGE_EXT = /\.(png|jpg|jpeg|gif|webp)$/i;
const QUERYABLE_OFFLOAD_TOOLS = new Set(["recall", "self_recall"]);

// Code in scratch is ambiguous: it can be the requested deliverable, or an
// unfinished generator for a PDF/PPTX/etc. Only surface it when the user
// explicitly asked for a code file. Execution remains a second exclusion gate
// because a requested-looking filename can still be a generator that was run.
function hasExplicitCodeDeliverableIntent(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return false;
  const action = "(?:create|write|generate|make|provide|return|deliver|save|export|edit|modify|fix)";
  const extension = "[a-z0-9][\\w.-]*\\.(?:ts|tsx|js|jsx|cjs|mjs|py|cs|go|java|rb|rs|cpp|cc|c|h|hpp|kt|swift|php|scala|sql|sh|bash|css|scss|less|vue|svelte|yaml|yml|toml)";
  const namedCode = "(?:source\\s+code|code\\s+file|(?:typescript|javascript|python|c#|c\\+\\+|java|ruby|rust|go|kotlin|swift|php|scala|sql|shell|bash|css|scss|vue|svelte|yaml|toml)(?:\\s+[a-z-]+){0,2}\\s+(?:file|script|module|component))";
  const target = `(?:${extension}|${namedCode})`;
  return new RegExp(`\\b${action}\\b[\\s\\S]{0,100}\\b${target}\\b`, "i").test(t) ||
    new RegExp(`\\b${target}\\b[\\s\\S]{0,100}\\b${action}\\b`, "i").test(t);
}

function hasGeneratedArtifactIntent(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return false;
  const action = "(?:create|generate|build|make|produce|convert|export|render)";
  const target = "(?:[a-z0-9][\\w.-]*\\.(?:pptx|pdf|docx|xlsx)|pptx|docx|xlsx|powerpoint|presentation|slide\\s+deck|slideshow|pdf\\s+(?:file|report|document)|(?:file|report|document)\\s+(?:as|to|in)\\s+pdf|word\\s+document|excel\\s+(?:file|workbook)|spreadsheet)";
  return new RegExp(`\\b${action}\\b[\\s\\S]{0,120}\\b${target}\\b`, "i").test(t) ||
    new RegExp(`\\b${target}\\b[\\s\\S]{0,120}\\b${action}\\b`, "i").test(t);
}

function canonicalizeEditArgs(args) {
  const oldAliases = ["old", "oldText", "oldStr", "old_str", "old string"];
  const newAliases = ["new", "newText", "newStr", "new_str", "new string"];
  const pick = (keys) => {
    for (const key of keys) {
      if (typeof args[key] === "string") return args[key];
    }
    return undefined;
  };
  if (typeof args.old_string !== "string") {
    const oldString = pick(oldAliases);
    if (oldString !== undefined) args.old_string = oldString;
  }
  if (typeof args.new_string !== "string") {
    const newString = pick(newAliases);
    if (newString !== undefined) args.new_string = newString;
  }
  for (const key of [...oldAliases, ...newAliases]) delete args[key];
  return args;
}

/**
 * One-time factory. Call once per agent session; the returned `makeTurnHooks`
 * is called at the start of each runAgentLoop invocation to create fresh
 * per-turn mutable state.
 */
export function createToolHooks({
  callTool,              // base MCP tool caller (from createAgent)
  offloadToolResult = null, // lossless oversized-result offloader
  readArtifact = null,   // owner-bound read-only artifact tool
  artifactReadToolName = "read_artifact",
  summarizeArgs,         // from lib/agent/toolActivity.js
  summarizeResult,       // from lib/agent/toolActivity.js
  getActiveScratchDir,   // from lib/routes/paths.js
  resolveScratchPath,    // from lib/routes/paths.js
  validateWrittenFile,   // from lib/tools/validateWrittenFile.js
  logger,                // the agent logger
  WRITE_TOOLS,           // Set of write-tool names (from tool-profiles.js)
  CONFIRM_TOOLS,         // Set of confirm-before-write tool names
  existsSync,            // from fs
  statSync,              // from fs
  readdirSync,           // from fs
  copyFileSync,          // from fs
  basename,              // from path
  join,                  // from path
}) {

  /**
   * Per-turn factory. Call at the start of every runAgentLoop invocation.
   * Creates fresh mutable state so each turn has its own failure budget,
   * download-card queue, and artifact dedup set.
   *
   * @param {object} emitter    — the turn's event emitter
   * @param {number} turnStartMs — Date.now() at turn start
   * @returns {object} hook functions + mutable state references
   */
  return function makeTurnHooks(
    emitter,
    turnStartMs,
    artifactContext = null,
    lifecycleTrace = null,
    turnContext = null,
  ) {
    let toolSeq = 0;
    const workflowSequence = []; // { name, summary, ok } per successful tool call this turn
    const activeScopes = [];     // { trigger, content, title, path } scope preferences active this turn
    let scopeUserQuery = "";
    const safety = createToolSafetyMiddleware({
      emitter,
      logger,
      writeTools: WRITE_TOOLS,
    });
    const safetyRunner = createLifecycleRunner(safety.middleware, { trace: lifecycleTrace });
    const { failures, taint, recordFailure, budgetMessage } = safety;
    const surfacedArtifacts = new Set();
    const offloadedArtifactIds = new Set();
    const retrievableOffloadSources = new Set();
    const offloadRunner = createLifecycleRunner([
      createToolResultOffloadMiddleware({
        offloadToolResult,
        artifactContext,
        artifactIds: offloadedArtifactIds,
        emitter,
        logger,
      }),
    ], { trace: lifecycleTrace });
    const downloadCards = [];
    // A generator's signed tool result is authoritative. Retain it so the final
    // answer guard verifies the exact file, including artifacts produced by an
    // isolated standalone MCP run outside this turn's session scratch.
    const verifiedArtifacts = new Map();
    const artifactLifecycle = createArtifactLifecycle({
      scratchDir: getActiveScratchDir(), existsSync, statSync, basename,
    });
    // Resolved paths of scripts the model executed this turn (run_node_script /
    // run_python_script). These are generators/intermediates — never surfaced as
    // code deliverables, even though their .js/.py extension otherwise would be.
    const executedScripts = new Set();
    const codeDeliverableIntent = hasExplicitCodeDeliverableIntent(turnContext?.userText);
    const generatedArtifactIntent = hasGeneratedArtifactIntent(turnContext?.userText);
    // ── Artifact surfacing ─────────────────────────────────────────────────

    /** Queue a download card for a file in the scratch workspace (no ext gate). */
    function pushCard(absPath) {
      let st;
      try { st = statSync(absPath); } catch { return; }
      const key = `${absPath}:${st.size}`;
      if (surfacedArtifacts.has(key)) return;
      // Normalize backslashes for Windows before splitting on the scratch root
      const rel = absPath.replace(/\\/g, "/").split("/var/scratch/")[1];
      if (!rel) return;
      surfacedArtifacts.add(key);
      const displayName = basename(absPath).replace(/^[0-9a-f]{8}-/, "");
      downloadCards.push({
        type: "generated_file",
        filename: displayName,
        url: `/scratch/${rel}`,
        sizeKb: Math.max(1, Math.round(st.size / 1024)),
      });
    }

    /** Queue a download card for a generated deliverable in the scratch workspace. */
    function surfaceArtifact(absPath) {
      // Chokepoint guard for docs/data/text: only deliverables become download
      // cards. Generator scripts and intermediates are never the "result" handed
      // to the user, no matter which call path reaches here. Source-code
      // deliverables go through surfaceCodeArtifacts instead (execution-aware).
      if (!DOWNLOADABLE_EXT.test(absPath)) return;
      pushCard(absPath);
    }

    /**
     * End-of-turn scan for source-code deliverables (a developer asked for a
     * .ts/.cs/.py/... file). Surfaces code files modified this turn, EXCEPT any
     * the model executed — those are generators producing the real artifact, not
     * the result. Deferred to turn end so the full set of executed scripts is
     * known before deciding what counts as a deliverable.
     */
    function surfaceCodeArtifacts() {
      if (!codeDeliverableIntent) return;
      const scratch = getActiveScratchDir();
      if (!scratch) return;
      for (const abs of listFilesRecursive(scratch)) {
        if (!CODE_EXT.test(abs)) continue;
        if (executedScripts.has(abs)) continue;   // generator, not a deliverable
        let st;
        try { st = statSync(abs); } catch { continue; }
        if (st.mtimeMs < turnStartMs - 1000) continue;
        pushCard(abs);
      }
    }

    /** Emit all queued download cards and reset the queue. */
    function flushDownloadCards() {
      surfaceCodeArtifacts();   // execution-aware code-deliverable scan (turn end)
      const seen = new Set();
      for (const card of downloadCards) {
        if (seen.has(card.url)) continue;
        seen.add(card.url);
        emitter.send(card);
      }
      downloadCards.length = 0;
    }

    /**
     * Recursively lists files under `dir`, up to `maxDepth` directory levels
     * below it. Models routinely nest a generated deliverable one level down
     * (observed: an invented "outputs/deck.pptx" folder) — a flat readdir
     * alone never surfaces it, so the file sits in the workspace with no
     * download/preview card even though it was written correctly. Skips
     * `node_modules` (a run_node_script-triggered `npm install` can drop tens
     * of thousands of files there) and dotfiles.
     */
    function listFilesRecursive(dir, maxDepth = 3) {
      const out = [];
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
      for (const e of entries) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const abs = join(dir, e.name);
        if (e.isFile()) out.push(abs);
        else if (e.isDirectory() && maxDepth > 0) out.push(...listFilesRecursive(abs, maxDepth - 1));
      }
      return out;
    }

    /** Scan the scratch workspace for new downloadable artifacts this turn. */
    function surfaceScratchArtifacts() {
      const scratch = getActiveScratchDir();
      if (!scratch) return;
      for (const abs of listFilesRecursive(scratch)) {
        if (!DOWNLOADABLE_EXT.test(abs)) continue;
        let st;
        try { st = statSync(abs); } catch { continue; }
        if (st.mtimeMs < turnStartMs - 1000) continue;
        surfaceArtifact(abs);
      }
    }

    async function finalizeToolResult(name, result) {
      const offloaded = await offloadRunner.run("afterTool", { name, result });
      if (!Object.is(offloaded.request.result, result) && !QUERYABLE_OFFLOAD_TOOLS.has(name)) {
        retrievableOffloadSources.add(name);
      }
      return offloaded.request.result;
    }

    // ── Main tool hook ─────────────────────────────────────────────────────

    async function callToolHooked(name, input) {
      const rawArgs = input?.parameters !== undefined ? input.parameters : (input ?? {});
      const beforeSafety = await safetyRunner.run("beforeTool", {
        name,
        callArgs: rawArgs,
      });
      if (beforeSafety.stopped) return beforeSafety.value;
      // Preserve the historical behavior where normalized paths and the
      // code-enforced __tainted flag are reflected in persisted tool-call
      // history. Middleware itself sees immutable snapshots; the boundary
      // explicitly applies its returned update to the original argument object.
      const callArgs = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
        ? Object.assign(rawArgs, beforeSafety.request.callArgs)
        : { ...beforeSafety.request.callArgs };

      // The MCP schema advertises a required canonical find/replace pair so
      // constrained models cannot emit half an edit. Preserve compatibility
      // with common weak-model aliases by translating them before validation.
      if (name === "edit_file") canonicalizeEditArgs(callArgs);

      // Resolve bare/relative paths against the session workspace before the
      // call crosses into the MCP subprocess (which has no scratch context).
      if (name === "write_file") {
        if (typeof callArgs.path === "string") callArgs.path = resolveScratchPath(callArgs.path, { redirectProjectRoot: true });
      } else if (name === "edit_file" || name === "append_file" || name === "read_file") {
        if (typeof callArgs.path === "string") callArgs.path = resolveScratchPath(callArgs.path, { mustExist: true });
      } else if (name === "run_node_script" || name === "run_python_script") {
        if (typeof callArgs.script === "string") {
          callArgs.script = resolveScratchPath(callArgs.script, { mustExist: true });
          executedScripts.add(callArgs.script);   // mark as generator, not a deliverable
        }
      } else if (name === "run_shell") {
        if (typeof callArgs.cwd !== "string" || !callArgs.cwd) {
          const scratch = getActiveScratchDir();
          callArgs.cwd = scratch && existsSync(scratch) ? scratch : process.cwd();
        }
      }

      // ── Scope-aware search path injection ───────────────────────────────
      // When an active scope preference matches the current query/pattern,
      // prepend the scope path to restrict search to the relevant directory.
      // This lets the model scope searches automatically based on stored
      // preferences like "when I mention auth, search /app/auth/oauth/ first".
      if (activeScopes.length > 0 && name === "grep_files") {
        const pattern = callArgs.pattern || "";
        const scope = selectSearchScope(activeScopes, { userQuery: scopeUserQuery, pattern });
        if (scope?.path) {
          callArgs.path = resolveScopedSearchPath(scope.path, callArgs.path);
        }
      }

      const callInput = input?.parameters !== undefined
        ? { ...input, parameters: callArgs }
        : callArgs;

      const seq = ++toolSeq;
      emitter.send({
        type: "tool_start",
        seq,
        name,
        arg: summarizeArgs(name, callArgs),
        // Keep the structured call available to private benchmark evidence;
        // the UI ignores this field and continues to render the short summary.
        arguments: { ...callArgs },
      });
      const startedAt = Date.now();
      const isArtifactRead = name === artifactReadToolName;
      const result = isArtifactRead
        ? (readArtifact && offloadedArtifactIds.size > 0
            ? await readArtifact(callArgs, artifactContext)
            : "❌ Artifact read error: no artifact was offloaded in this run")
        : await callTool(name, callInput);
      const { ok, summary, details, detail, memories } = summarizeResult(name, result);
      artifactLifecycle.recordToolResult(name, callArgs, result);
      emitter.send({ type: "tool_result", seq, name, ok, summary, ms: Date.now() - startedAt, ...(details ? { details } : {}), ...(detail ? { detail } : {}), ...(memories ? { memories } : {}) });
      // Track only successful, explicitly meaningful actions. Ordinary reads,
      // recall, and searches orient the turn but do not form workflows alone.
      if (ok && isMeaningfulWorkflowTool(name)) {
        workflowSequence.push({ name, summary: summarizeArgs(name, callArgs), ok });
      }
      if (isArtifactRead) return result;

      const afterSafety = await safetyRunner.run("afterTool", {
        name,
        callArgs,
        result,
        modelResult: result,
      });
      if (afterSafety.stopped) return afterSafety.value;
      let modelResult = afterSafety.request.modelResult;

      // Surface a download card for write_file output that lands in the scratch
      // workspace, so the user can preview/download the file without searching
      // the folder manually. Only DELIVERABLES (see DOWNLOADABLE_EXT: docs, data,
      // and text files like .txt/.md) get a card — never generator scripts
      // (.js/.cjs/.py) or intermediates, which are means-to-an-end the user
      // should not be handed as "the result".
      if (name === "write_file" && ok && typeof callArgs.path === "string"
          && callArgs.path.replace(/\\/g, "/").includes("/var/scratch/") && DOWNLOADABLE_EXT.test(callArgs.path)) {
        surfaceArtifact(callArgs.path);
      }

      if (name === "recall" && result && result !== "No memories found." && result !== "No result") {
        emitter.send({ type: "recall_result", text: result });
      }
      if (name === "remember") {
        const args = callArgs;
        if (args.expires_at) {
          const expiryDate = new Date(args.expires_at);
          const isValidFuture = !Number.isNaN(expiryDate.getTime()) && expiryDate > new Date(Date.now() + 3600_000);
          if (isValidFuture) {
            const idMatch = typeof result === "string" && result.match(/\(id: ([0-9a-f-]{36})\)/);
            if (idMatch) {
              emitter.send({ type: "ttl_chip", id: idMatch[1], memType: args.type, title: args.title, expires_at: args.expires_at });
            }
          }
        }
      }
      if ((name === "generate_xlsx" || name === "generate_docx") && typeof result === "string" && result.startsWith("APERIO_FILE:")) {
        try {
          const fileInfo = JSON.parse(result.slice("APERIO_FILE:".length));
          if (typeof fileInfo.path === "string" && existsSync(fileInfo.path)) {
            verifiedArtifacts.set(basename(fileInfo.filename), fileInfo);
          }
          downloadCards.push({
            type: "generated_file",
            filename: fileInfo.filename,
            url: fileInfo.url,
            sizeKb: fileInfo.sizeKb,
            ...(fileInfo.path ? { path: fileInfo.path } : {}),
          });
          const savedAt = fileInfo.path ? `\nSaved at: ${fileInfo.path}` : "";
          const pathInstruction = fileInfo.path
            ? "\nUse this exact verified path in your final answer; do not repeat a directory from the filename argument."
            : "";
          return `✅ Created ${fileInfo.filename} (${fileInfo.sizeKb} KB) — available for download.${savedAt}${pathInstruction}`;
        } catch (parseErr) {
          logger.error(`[callToolHooked] APERIO_FILE parse failed: ${parseErr.message}`);
        }
      }
      // Post-write validation. Skip when the result is a pending-confirm propose
      // (WRITE-01) — nothing has been written yet, so there is nothing to validate.
      const isPendingConfirm = typeof result === "string" && /\bToken:\s*(?:iss|del|wr|db)_[a-z0-9]+\b/i.test(result);
      if (WRITE_TOOLS.has(name) && typeof result === "string" && !result.startsWith("❌") && !isPendingConfirm) {
        const args = callArgs;
        const targetPath = args?.path;
        if (typeof targetPath === "string" && targetPath) {
          try {
            const v = await validateWrittenFile(targetPath);
            if (!v.ok) {
              logger.warn(`[callToolHooked] post-write ${v.lang} validation failed for ${targetPath}: ${v.message}`);
              recordFailure("postWriteValidation", `${v.lang} ${targetPath}: ${v.message}`);
              if (failures.count >= TOOL_FAILURE_BUDGET) return budgetMessage();
              return (
                `${result}\n\n` +
                `⚠️ POST-WRITE VALIDATION FAILED — ${v.lang} parse error in ${targetPath}:\n${v.message}\n\n` +
                `The file was written but is no longer valid ${v.lang}. ` +
                `Read it back with read_file, identify the corruption (often a misplaced quote, escaped character, or truncated string), ` +
                `and fix it with edit_file (targeted replacement) before continuing. Your next tool call must repair the file; do not call the generator or claim success until syntax_check passes. Do NOT tell the user the change succeeded.`
              );
            }
          } catch (err) {
            logger.error(`[callToolHooked] validator threw for ${targetPath}: ${err.message}`);
          }
        }
      }
      // A written generator is only an intermediate in a rich-file workflow.
      // Weak models otherwise tend to stop after write_file and the end-of-turn
      // code scanner can make the script look like the requested artifact.
      if (name === "write_file" && ok && generatedArtifactIntent && typeof callArgs.path === "string") {
        const scratch = getActiveScratchDir()?.replace(/[\\/]+$/, "").replace(/\\/g, "/");
        const normalizedPath = callArgs.path.replace(/\\/g, "/");
        if (scratch && normalizedPath.startsWith(`${scratch}/`) && RUNNER_SCRIPT_EXT.test(normalizedPath) && typeof modelResult === "string") {
          const runner = /\.py$/i.test(normalizedPath) ? "run_python_script" : "run_node_script";
          modelResult +=
            `\n\n⚠️ INTERMEDIATE GENERATOR ONLY — the user requested a rendered document/presentation, not this source file. ` +
            `Your next step is to execute it with ${runner}, verify the requested output exists and is valid, and only then finish the turn. ` +
            `Do not present this script as the completed deliverable.`;
        }
      }
      // PPTX marker handling + artifact surfacing for script tools
      if ((name === "run_node_script" || name === "run_python_script") && typeof result === "string") {
        const markerMatch = result.match(/APERIO_PPTX:(\{[^\n]*\})/);
        if (markerMatch) {
          try {
            const info = JSON.parse(markerMatch[1]);
            if (info?.path) {
              if (!existsSync(info.path)) {
                logger.error(`[callToolHooked] APERIO_PPTX claims ${info.path} but it is not on disk`);
                recordFailure("pptxFileMissing", info.path);
                if (failures.count >= TOOL_FAILURE_BUDGET) return budgetMessage();
                return `❌ Script printed APERIO_PPTX marker for ${info.path} but the file does NOT exist on disk. Do not tell the user the file was created. Investigate stderr above and retry.\n\n${result}`;
              }
              const st = statSync(info.path);
              if (st.size !== info.size) {
                logger.warn(`[callToolHooked] APERIO_PPTX size mismatch ${info.path}: marker=${info.size} disk=${st.size}`);
              }
              if (info.path.toLowerCase().endsWith(".pptx") && (info.action === "pack" || info.action === "verify")) {
                artifactLifecycle.recordPptxVerification(info);
                surfaceArtifact(info.path);
              }
            }
          } catch (parseErr) {
            logger.error(`[callToolHooked] APERIO_PPTX parse failed: ${parseErr.message}`);
          }
        }
        surfaceScratchArtifacts();

        // Copy image files printed by script stdout into the scratch workspace
        // so the browser can load them via /scratch/ URLs.
        const scratchDir = getActiveScratchDir();
        if (scratchDir) {
          const imgPaths = [...result.matchAll(/^(\/[^\s]+)/gm)]
            .map(m => m[1])
            .filter(p => IMAGE_EXT.test(p) && existsSync(p));
          if (imgPaths.length) {
            const urls = [];
            for (const absPath of imgPaths) {
              try {
                const dest = join(scratchDir, basename(absPath));
                copyFileSync(absPath, dest);
                const rel = dest.replace(/\\/g, "/").split("/var/scratch/")[1];
                if (rel) urls.push(`/scratch/${rel}`);
              } catch (copyErr) {
                logger.warn(`[callToolHooked] image copy failed: ${copyErr.message}`);
              }
            }
            if (urls.length) {
              let patched = result;
              for (let i = 0; i < imgPaths.length; i++) {
                if (urls[i]) patched = patched.replaceAll(imgPaths[i], urls[i]);
              }
              return finalizeToolResult(name, patched);
            }
          }
        }
      }
      // Confirm-before-write tools
      if (typeof result === "string") {
        const tokenMatch = result.match(/\bToken:\s*((?:iss|del|wr|db|idx)_[a-z0-9]+)\b/i);
        if (tokenMatch && CONFIRM_TOOLS.has(name)) {
          const token = tokenMatch[1];
          let label, summary, destructive = false;
          if (name === "delete_file") {
            const pathArg = callArgs.path || "";
            label = `Delete ${pathArg.split("/").pop() || pathArg}`;
            summary = `Target: ${pathArg}`;
            destructive = true;
          } else {
            const labelMatch = result.match(/^Action:\s*(.+)$/m);
            label = labelMatch ? labelMatch[1].trim() : "Confirm action";
            summary = result.split(/\nAction:/)[0].replace(/^📋.*\n+/, "").trim();
            // db_execute can DROP/DELETE — style its confirm as destructive.
            destructive = name === "db_execute";
          }
          emitter.send({ type: "action_confirm_pending", token, label, summary, tool: name, destructive });
          emitter._confirmPending = true;
          return `⚠️ Pending user confirmation: ${label}.\n\nA confirm button has been shown to the user (in the terminal, a token to reply with); the action runs when they confirm. STOP — do NOT call ${name} again and do NOT wait. End your turn now.`;
        }
      }

      return finalizeToolResult(name, modelResult);
    }

    // ── Final-answer hallucination guard ────────────────────────────────────

    function verifyFileClaims(text) {
      const scratch = getActiveScratchDir();
      if (!scratch) return;
      // Recursive, not a flat readdir: a claimed deliverable can sit one level
      // down (a model-invented "outputs/" folder — see surfaceScratchArtifacts)
      // and a flat scan would wrongly report it as a hallucinated/missing claim
      // even though it exists. Values are paths relative to `scratch` (possibly
      // nested) so `join(scratch, diskName)` below still resolves correctly.
      const scratchFiles = new Map();
      for (const abs of listFilesRecursive(scratch)) {
        const rel = abs.slice(scratch.length + 1);
        const diskBasename = basename(abs);
        scratchFiles.set(diskBasename, rel);
        scratchFiles.set(diskBasename.replace(/^[0-9a-f]{8}-/i, ""), rel);
      }

      const present = new Set();
      const issues = new Map();
      const check = (name) => {
        const verified = verifiedArtifacts.get(name);
        if (verified?.path && existsSync(verified.path)) {
          present.add(name);
          return;
        }
        const diskName = scratchFiles.get(name);
        if (diskName) {
          const path = join(scratch, diskName);
          if (/\.pptx$/i.test(name)) {
            const status = artifactLifecycle.inspectPptx(path);
            if (!status.ok) {
              issues.set(name, status.reason);
              return;
            }
          }
          present.add(name);
          surfaceArtifact(path);
          return;
        }
        issues.set(name, "missing");
      };

      // Match a deliverable claim and a filename in EITHER order on the same line.
      // The model phrases success both ways: "generated output.pdf" (verb first)
      // and "output.pdf has been generated" (file first) — both are claims. The
      // verb set covers active creation AND passive availability ("output.pdf is
      // ready", "the report is available") since weak models routinely announce a
      // file as done without a creation verb.
      const VERB = "(?:created|saved|wrote|written|generated|produced|exported|converted|ready|available|located|placed|waiting)";
      const FILE = "([A-Za-z0-9][\\w.-]*\\.(?:pptx|pdf|docx|xlsx|xls|csv))";
      const VERB_THEN_FILE = new RegExp(`\\b${VERB}\\b[^\\n]*?${FILE}`, "gi");
      // Reverse order ("output.pdf has been generated") requires a passive
      // auxiliary right after the file, then the verb within the same clause, so
      // we don't bind a creation verb to a file the model merely read ("read
      // input.pdf and produced X"). Closing punctuation (backtick/quote) between
      // the file and the auxiliary is tolerated.
      const AUX = "(?:(?:has|have) been|was|were|is|are|successfully)";
      const FILE_THEN_VERB = new RegExp(`${FILE}[\\s\`'")\\]*.,]*${AUX}\\s+(?:\\w+\\s+){0,2}${VERB}\\b`, "gi");
      for (const m of text.matchAll(VERB_THEN_FILE)) check(basename(m[1].trim()));
      for (const m of text.matchAll(FILE_THEN_VERB)) check(basename(m[1].trim()));
      // Models also announce fabricated deliverables under a separate output
      // label, detached from the success verb by a newline. Treat the label as
      // an existence claim in its own right.
      const OUTPUT_PATH = /\bOutput\s+Path\s*:\s*[`'"]?(?:\.\/)?([A-Za-z0-9][\w.-]*\.(?:pptx|pdf|docx|xlsx|xls|csv))/gi;
      for (const m of text.matchAll(OUTPUT_PATH)) check(basename(m[1].trim()));

      // Any absolute path under THIS session's workspace that the model cites is
      // an existence claim regardless of the surrounding verb — "ready at <path>",
      // "you can find it at <path>", or a bare path on its own line. Verify each
      // directly (existsSync handles subdirectories that a flat readdir misses).
      const scratchEsc = scratch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const SCRATCH_PATH = new RegExp(`${scratchEsc}/[\\w./-]*\\.(?:pptx|pdf|docx|xlsx|xls|csv)`, "gi");
      for (const m of text.matchAll(SCRATCH_PATH)) {
        const name = basename(m[0]);
        if (!existsSync(m[0])) issues.set(name, "missing");
        else if (/\.pptx$/i.test(name)) {
          const status = artifactLifecycle.inspectPptx(m[0]);
          if (status.ok) present.add(name);
          else issues.set(name, status.reason);
        } else present.add(name);
      }

      for (const name of present) issues.delete(name);
      if (!issues.size) return;

      const missingList = [...issues].filter(([, reason]) => reason === "missing").map(([name]) => name);
      const unverifiedList = [...issues].filter(([, reason]) => reason !== "missing").map(([name]) => name);
      logger.warn(`[verifyFileClaims] invalid artifact claim(s): ${[...issues].map(([name, reason]) => `${name} (${reason})`).join(", ")}`);
      const clauses = [];
      if (missingList.length) {
        const list = missingList.map(n => `\`${n}\``).join(", ");
        clauses.push(`${list} ${missingList.length > 1 ? "are" : "is"} not actually in the workspace`);
      }
      if (unverifiedList.length) {
        const list = unverifiedList.map(n => `\`${n}\``).join(", ");
        const hasPendingRevision = unverifiedList.some(name => issues.get(name) === "latest-script-not-executed");
        clauses.push(hasPendingRevision
          ? `${list} cannot be claimed as complete because the latest script revision was not executed and verified`
          : `${list} exists but was not verified after generation`);
      }
      const warning =
        `\n\n⚠️ **Correction:** ${clauses.join("; ")}. ` +
        `Please disregard my earlier success claim.`;
      emitter.send({ type: "stream_start" });
      emitter.send({ type: "token", text: warning.trimStart() });
      emitter.send({ type: "stream_end", text: warning.trim() });
    }

    return {
      callToolHooked,
      surfaceArtifact,
      surfaceScratchArtifacts,
      flushDownloadCards,
      verifyFileClaims,
      toolSeq: { get value() { return toolSeq; } },
      // Shared allocator for provider loops that synthesize their own
      // tool_start/tool_result cards alongside callToolHooked in the same
      // turn (claude-code's built-in-tool bridge — its Aperio tools already
      // go through callToolHooked above and share this same counter). Two
      // independent counters would both start at 1 and collide on the
      // frontend's seq-keyed card map.
      nextToolSeq: () => ++toolSeq,
      workflowSequence,
      activeScopes,
      setActiveSearchScopes(scopes, userQuery = "") {
        activeScopes.length = 0;
        activeScopes.push(...scopes);
        scopeUserQuery = userQuery;
      },
      failures,
      taint,
      safetyMiddlewareNames: TOOL_SAFETY_MIDDLEWARE_NAMES,
      hasOffloadedArtifacts: () => offloadedArtifactIds.size > 0,
      hasRetrievableOffloadedArtifacts: () => retrievableOffloadSources.size > 0,
    };
  };
}
