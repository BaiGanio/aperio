// lib/helpers/promptCacheLog.js
//
// Prompt-cache hygiene WS3 (trash/plans/prompt-cache-hygiene): a pure parser
// over llama-server's own debug log (var/llamacpp/<session-id>.log or the
// shared server.log) that extracts, per request, the slot-cache signal
// llama.cpp already reports on stdout:
//
//   slot get_availabl: ... selected slot by LRU, t_last = -1
//   slot get_availabl: ... selected slot by LCP similarity, sim_best = 0.823 (> 0.100 thold), f_keep = 1.000
//   slot launch_slot_: ... task 804 | processing task, is_child = 0
//   slot print_timing: ... task 804 | prompt eval time =   9200.00 ms /  1872 tokens (...)
//
// The three line kinds are correlated by task id, but task id only appears on
// the *second* line (launch_slot_) — the preceding get_availabl selection
// line carries no task id of its own (it logs `task -1`). This module pairs
// each selection line with the very next launch_slot_ line to learn the real
// task id, then later attaches the matching print_timing "prompt eval time"
// line to that same task id.
//
// No live server needed — see tests/lib/helpers/promptCacheLog.test.js
// (fixture-driven, matches the doctrine startLlamaCpp.test.js/localBench.js
// already use for injectable I/O).

const SELECTION_LCP_RE = /slot get_availabl:.*\|\s*task -1\s*\|\s*selected slot by LCP similarity,\s*sim_best\s*=\s*([\d.]+)\s*\(>\s*[\d.]+\s*thold\),\s*f_keep\s*=\s*([\d.]+)/;
const SELECTION_LRU_RE = /slot get_availabl:.*\|\s*task -1\s*\|\s*selected slot by LRU/;
const LAUNCH_RE = /slot launch_slot_:.*\|\s*task\s*(\d+)\s*\|\s*processing task/;
const PROMPT_EVAL_RE = /slot print_timing:.*\|\s*task\s*(\d+)\s*\|\s*prompt eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens/;

// llama-server's stdout tee can interleave a NUL-holed chunk into the
// per-session log when the pump races a partial write (see stripNuls() in
// startLlamaCpp.js). Strip embedded NULs per line rather than failing the
// whole parse.
function cleanLine(raw) {
  return raw.includes("\0") ? raw.replace(/\0/g, "") : raw;
}

function matchSelection(line) {
  const lcp = line.match(SELECTION_LCP_RE);
  if (lcp) return { selection: "lcp", sim: Number(lcp[1]), fKeep: Number(lcp[2]) };
  if (SELECTION_LRU_RE.test(line)) return { selection: "lru", sim: null, fKeep: null };
  return null;
}

/**
 * Parse a llama-server debug log (session-scoped or the shared server.log)
 * into one record per request that reached prompt-eval.
 *
 * @param {string} text raw log contents
 * @returns {Array<{taskId: number, selection: "lru"|"lcp"|null, sim: number|null, fKeep: number|null, promptTokens: number, promptMs: number}>}
 *   Ordered by appearance in the log. A request whose "prompt eval time" line
 *   never arrives (e.g. the log was truncated mid-request) is omitted rather
 *   than returned half-filled.
 */
export function parseServerLog(text) {
  const records = [];
  let pendingSelection = null;

  for (const raw of (text ?? "").split(/\r?\n/)) {
    if (!raw) continue;
    const line = cleanLine(raw);

    const selection = matchSelection(line);
    if (selection) { pendingSelection = selection; continue; }

    const launch = line.match(LAUNCH_RE);
    if (launch) {
      records.push({
        taskId: Number(launch[1]),
        selection: pendingSelection?.selection ?? null,
        sim: pendingSelection?.sim ?? null,
        fKeep: pendingSelection?.fKeep ?? null,
        promptTokens: null,
        promptMs: null,
      });
      pendingSelection = null;
      continue;
    }

    const evalTiming = line.match(PROMPT_EVAL_RE);
    if (evalTiming) {
      const taskId = Number(evalTiming[1]);
      // Search from the most recent record backward: a restarted server can
      // reuse small task ids, so the *latest* still-open record for this
      // task id is the right one to fill in, not the first.
      for (let i = records.length - 1; i >= 0; i--) {
        if (records[i].taskId === taskId && records[i].promptMs === null) {
          records[i].promptMs = Number(evalTiming[2]);
          records[i].promptTokens = Number(evalTiming[3]);
          break;
        }
      }
    }
  }

  return records.filter(r => r.promptMs !== null);
}

// Human-readable report over parseServerLog()'s output — scripts/
// prompt-cache-bench.js's actual console output, factored out so it unit-
// tests without capturing stdout (matches localBench.js's formatReport).
export function formatPromptCacheReport(records) {
  if (!records.length) return "No requests found in this log.";
  const lines = ["Prompt-cache reuse per request (trash/plans/prompt-cache-hygiene, WS3):", ""];
  records.forEach((r, i) => {
    const reuse = r.selection === "lru"
      ? "cold (LRU — no prefix match)"
      : `sim_best=${r.sim.toFixed(3)} f_keep=${r.fKeep.toFixed(3)}`;
    lines.push(`  #${i + 1} task ${r.taskId}: ${reuse} — reprocessed ${r.promptTokens} tok in ${r.promptMs.toFixed(0)} ms`);
  });
  return lines.join("\n");
}
