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

const DOWNLOADABLE_EXT = /\.(pptx|pdf|docx|xlsx|xls|csv)$/i;
const IMAGE_EXT = /\.(png|jpg|jpeg|gif|webp)$/i;
const FAILURE_BUDGET = 3;

/**
 * One-time factory. Call once per agent session; the returned `makeTurnHooks`
 * is called at the start of each runAgentLoop invocation to create fresh
 * per-turn mutable state.
 */
export function createToolHooks({
  callTool,              // base MCP tool caller (from createAgent)
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
  return function makeTurnHooks(emitter, turnStartMs) {
    let toolSeq = 0;
    const failures = { count: 0, kinds: [] };
    const surfacedArtifacts = new Set();
    const downloadCards = [];

    // ── Artifact surfacing ─────────────────────────────────────────────────

    /** Queue a download card for a generated artifact in the scratch workspace. */
    function surfaceArtifact(absPath) {
      let st;
      try { st = statSync(absPath); } catch { return; }
      const key = `${absPath}:${st.size}`;
      if (surfacedArtifacts.has(key)) return;
      const rel = absPath.split("/var/scratch/")[1];
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

    /** Emit all queued download cards and reset the queue. */
    function flushDownloadCards() {
      const seen = new Set();
      for (const card of downloadCards) {
        if (seen.has(card.url)) continue;
        seen.add(card.url);
        emitter.send(card);
      }
      downloadCards.length = 0;
    }

    /** Scan the scratch workspace for new downloadable artifacts this turn. */
    function surfaceScratchArtifacts() {
      const scratch = getActiveScratchDir();
      if (!scratch) return;
      let entries;
      try { entries = readdirSync(scratch, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (!e.isFile() || !DOWNLOADABLE_EXT.test(e.name)) continue;
        const abs = join(scratch, e.name);
        let st;
        try { st = statSync(abs); } catch { continue; }
        if (st.mtimeMs < turnStartMs - 1000) continue;
        surfaceArtifact(abs);
      }
    }

    // ── Failure budgeting ──────────────────────────────────────────────────

    function recordFailure(kind, detail = "") {
      failures.count++;
      failures.kinds.push(kind);
      const short = String(detail).replace(/\s+/g, " ").slice(0, 200);
      logger.warn(`[callToolHooked] tool failure ${failures.count}/${FAILURE_BUDGET} (${kind}): ${short}`);
      emitter.send({ type: "tool_failure", count: failures.count, budget: FAILURE_BUDGET, kind, detail: short });
      if (failures.count >= FAILURE_BUDGET) {
        emitter.send({ type: "tool_budget_exhausted", count: failures.count, kinds: failures.kinds });
      }
    }

    function budgetMessage() {
      const counts = failures.kinds.reduce((acc, k) => (acc[k] = (acc[k] || 0) + 1, acc), {});
      const summary = Object.entries(counts).map(([k, n]) => `${k}×${n}`).join(", ");
      const causes = [];
      if (counts.parseArgs)            causes.push("you produced malformed JSON in your tool-call arguments (missing colons, unclosed quotes, or unescaped characters inside string values) — this is YOUR output, not a tool malfunction");
      if (counts.postWriteValidation)  causes.push("you wrote a file whose contents do not parse as valid JS/JSON/XML — the file lives on disk but is syntactically broken");
      if (counts.pptxFileMissing)      causes.push("a script printed an APERIO_PPTX success marker but the file is not actually on disk");
      const causeBlock = causes.length ? "Root cause(s):\n  - " + causes.join("\n  - ") + "\n\n" : "";
      return (
        `❌ TOOL-CALL BUDGET EXHAUSTED — ${failures.count} failed tool call(s) in this turn (${summary}). ` +
        `Stop calling tools immediately.\n\n` +
        causeBlock +
        `Do NOT tell the user that "the tool is broken" or "write_file is corrupting code" — that is incorrect. ` +
        `The Aperio tools work; the failure is in the JSON you generated for their arguments, or in the file contents you produced.\n\n` +
        `Tell the user verbatim:\n` +
        `"I produced ${failures.count} invalid tool calls in a row (${summary}) and hit the per-turn safety budget, so I stopped before corrupting anything. ` +
        `This is a sign the current model is degraded for this specific task. Please retry with a stronger model, or paste the generator code inline and I'll run it instead of writing it."`
      );
    }

    // ── Main tool hook ─────────────────────────────────────────────────────

    async function callToolHooked(name, input) {
      if (failures.count >= FAILURE_BUDGET) {
        return budgetMessage();
      }
      const callArgs = input?.parameters !== undefined ? input.parameters : (input ?? {});

      // Resolve bare/relative paths against the session workspace before the
      // call crosses into the MCP subprocess (which has no scratch context).
      if (name === "write_file") {
        if (typeof callArgs.path === "string") callArgs.path = resolveScratchPath(callArgs.path);
      } else if (name === "edit_file" || name === "append_file" || name === "read_file") {
        if (typeof callArgs.path === "string") callArgs.path = resolveScratchPath(callArgs.path, { mustExist: true });
      } else if (name === "run_node_script" || name === "run_python_script") {
        if (typeof callArgs.script === "string") callArgs.script = resolveScratchPath(callArgs.script, { mustExist: true });
      } else if (name === "run_shell") {
        if (typeof callArgs.cwd !== "string" || !callArgs.cwd) {
          const scratch = getActiveScratchDir();
          callArgs.cwd = scratch && existsSync(scratch) ? scratch : process.cwd();
        }
      }

      const seq = ++toolSeq;
      emitter.send({ type: "tool_start", seq, name, arg: summarizeArgs(name, callArgs) });
      const startedAt = Date.now();
      const result = await callTool(name, input);
      const { ok, summary } = summarizeResult(name, result);
      emitter.send({ type: "tool_result", seq, name, ok, summary, ms: Date.now() - startedAt });

      // Detect parseArgs failures
      if (typeof result === "string" && result.startsWith("❌") && /valid JSON/i.test(result)) {
        recordFailure("parseArgs", `${name}: ${result}`);
        if (failures.count >= FAILURE_BUDGET) return budgetMessage();
      } else if (typeof result === "string" && result.startsWith("❌ Tool error")) {
        recordFailure("toolError", `${name}: ${result}`);
        if (failures.count >= FAILURE_BUDGET) return budgetMessage();
      }
      if (name === "recall" && result && result !== "No memories found." && result !== "No result") {
        emitter.send({ type: "recall_result", text: result });
      }
      if (name === "remember") {
        const args = input?.parameters !== undefined ? input.parameters : (input ?? {});
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
          downloadCards.push({ type: "generated_file", filename: fileInfo.filename, url: fileInfo.url, sizeKb: fileInfo.sizeKb });
          const savedAt = fileInfo.path ? `\nSaved at: ${fileInfo.path}` : "";
          return `✅ Created ${fileInfo.filename} (${fileInfo.sizeKb} KB) — available for download.${savedAt}`;
        } catch (parseErr) {
          logger.error(`[callToolHooked] APERIO_FILE parse failed: ${parseErr.message}`);
        }
      }
      // Post-write validation
      if (WRITE_TOOLS.has(name) && typeof result === "string" && !result.startsWith("❌")) {
        const args = input?.parameters !== undefined ? input.parameters : (input ?? {});
        const targetPath = args?.path;
        if (typeof targetPath === "string" && targetPath) {
          try {
            const v = await validateWrittenFile(targetPath);
            if (!v.ok) {
              logger.warn(`[callToolHooked] post-write ${v.lang} validation failed for ${targetPath}: ${v.message}`);
              recordFailure("postWriteValidation", `${v.lang} ${targetPath}: ${v.message}`);
              if (failures.count >= FAILURE_BUDGET) return budgetMessage();
              return (
                `${result}\n\n` +
                `⚠️ POST-WRITE VALIDATION FAILED — ${v.lang} parse error in ${targetPath}:\n${v.message}\n\n` +
                `The file was written but is no longer valid ${v.lang}. ` +
                `Read it back with read_file, identify the corruption (often a misplaced quote, escaped character, or truncated string), ` +
                `and fix it with edit_file (targeted replacement) before continuing. Do NOT tell the user the change succeeded.`
              );
            }
          } catch (err) {
            logger.error(`[callToolHooked] validator threw for ${targetPath}: ${err.message}`);
          }
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
                if (failures.count >= FAILURE_BUDGET) return budgetMessage();
                return `❌ Script printed APERIO_PPTX marker for ${info.path} but the file does NOT exist on disk. Do not tell the user the file was created. Investigate stderr above and retry.\n\n${result}`;
              }
              const st = statSync(info.path);
              if (st.size !== info.size) {
                logger.warn(`[callToolHooked] APERIO_PPTX size mismatch ${info.path}: marker=${info.size} disk=${st.size}`);
              }
              if (info.path.toLowerCase().endsWith(".pptx") && (info.action === "pack" || info.action === "verify")) {
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
                const rel = dest.split("/var/scratch/")[1];
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
              return patched;
            }
          }
        }
      }
      // Confirm-before-write tools
      if (typeof result === "string") {
        const tokenMatch = result.match(/\bToken:\s*((?:iss|del)_[a-z0-9]+)\b/i);
        if (tokenMatch && CONFIRM_TOOLS.has(name)) {
          const token = tokenMatch[1];
          let label, summary, destructive = false;
          if (name === "delete_file") {
            const pathArg = ((input?.parameters !== undefined ? input.parameters : input) ?? {}).path || "";
            label = `Delete ${pathArg.split("/").pop() || pathArg}`;
            summary = `Target: ${pathArg}`;
            destructive = true;
          } else {
            const labelMatch = result.match(/^Action:\s*(.+)$/m);
            label = labelMatch ? labelMatch[1].trim() : "Confirm action";
            summary = result.split(/\nAction:/)[0].replace(/^📋.*\n+/, "").trim();
          }
          emitter.send({ type: "action_confirm_pending", token, label, summary, tool: name, destructive });
          emitter._confirmPending = true;
          return `⚠️ Pending user confirmation: ${label}.\n\nA confirm button has been shown to the user (in the terminal, a token to reply with); the action runs when they confirm. STOP — do NOT call ${name} again and do NOT wait. End your turn now.`;
        }
      }

      return result;
    }

    // ── Final-answer hallucination guard ────────────────────────────────────

    function verifyFileClaims(text) {
      const scratch = getActiveScratchDir();
      if (!scratch) return;
      const CLAIM_RE = /\b(?:created|saved|wrote|written|generated|produced|exported|converted)\b[^\n]*?([A-Za-z0-9][\w.-]*\.(?:pptx|pdf|docx|xlsx|xls|csv))/gi;
      const claimed = new Set();
      for (const m of text.matchAll(CLAIM_RE)) claimed.add(basename(m[1].trim()));
      if (!claimed.size) return;

      let onDisk;
      try { onDisk = new Set(readdirSync(scratch)); } catch { return; }

      for (const name of claimed) {
        if (onDisk.has(name)) surfaceArtifact(join(scratch, name));
      }

      const missing = [...claimed].filter(name => !onDisk.has(name));
      if (!missing.length) return;

      logger.warn(`[verifyFileClaims] model claimed file(s) not in workspace: ${missing.join(", ")}`);
      const list = missing.map(n => `\`${n}\``).join(", ");
      const warning =
        `\n\n⚠️ **Correction:** I told you I created ${list}, but ${missing.length > 1 ? "those files are" : "that file is"} ` +
        `not actually in the workspace — the step that should have produced ${missing.length > 1 ? "them" : "it"} did not succeed. ` +
        `Please disregard that claim; the file was not generated.`;
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
      failures,
    };
  };
}
