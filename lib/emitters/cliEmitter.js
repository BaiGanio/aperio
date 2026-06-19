
/**
 * CLI emitter — used by scripts/chat.js.
 *
 * Design goals:
 *   • Answer is the star — printed as "A: <text>" with no preamble clutter
 *   • Tool use is a single dim line, not a banner
 *   • Reasoning is optional and gated by showReasoning flag
 *   • Spinner stops cleanly before any text lands on screen
 *   • All debug noise stays on stderr, never touches stdout
 *
 * @param {function} onTurnDone    - Called when stream_end arrives
 * @param {object}   hooks         - { stopSpinner, startSpinner }
 * @param {object}   options       - { showReasoning: bool }
 */
export function makeCliEmitter(onTurnDone, hooks = {}, options = {}) {
  const { stopSpinner = () => {}, startSpinner = () => {} } = hooks;
  const { showReasoning = false } = options;

  // ── ANSI palette ────────────────────────────────────────────────────────────
  const R       = "\x1b[0m";
  const BOLD    = "\x1b[1m";
  const DIM     = "\x1b[2m";
  const ITALIC  = "\x1b[3m";
  const CYAN    = "\x1b[36m";
  const GRAY    = "\x1b[90m";
  const GREEN   = "\x1b[32m";
  const RED     = "\x1b[31m";
  const YELLOW  = "\x1b[33m";
  const MAGENTA = "\x1b[35m";
  const BLUE    = "\x1b[34m";
  const BG_CODE = "\x1b[48;5;236m"; // dark bg for inline code

  // ── Markdown → ANSI renderer ────────────────────────────────────────────────
  // Called once on the complete answer buffer at stream_end.
  function renderMarkdown(text) {
    const lines  = text.split("\n");
    const out    = [];
    let inFence  = false;
    let lang     = "";

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];

      // ── fenced code blocks ─────────────────────────────────────────────
      const fenceMatch = line.match(/^(`{3,})([\w+-]*)/);
      if (fenceMatch) {
        if (!inFence) {
          inFence = true;
          lang    = fenceMatch[2] || "";
          const badge = lang ? ` ${DIM}${lang}${R}` : "";
          out.push(`${GRAY}┌─${badge}`);
        } else {
          inFence = false;
          out.push(`${GRAY}└─${R}`);
        }
        continue;
      }

      if (inFence) {
        out.push(`${GRAY}│${R} ${CYAN}${line}${R}`);
        continue;
      }

      // ── headings ───────────────────────────────────────────────────────
      const h3 = line.match(/^### (.+)/);
      const h2 = line.match(/^## (.+)/);
      const h1 = line.match(/^# (.+)/);
      if (h1) { out.push(`\n${BOLD}${CYAN}${h1[1]}${R}`); continue; }
      if (h2) { out.push(`\n${BOLD}${h2[1]}${R}`); continue; }
      if (h3) { out.push(`${BOLD}${DIM}${h3[1]}${R}`); continue; }

      // ── horizontal rule ────────────────────────────────────────────────
      if (/^[-*_]{3,}$/.test(line.trim())) {
        out.push(`${GRAY}${"─".repeat(48)}${R}`);
        continue;
      }

      // ── bullet / numbered list ─────────────────────────────────────────
      line = line.replace(/^(\s*)([-*+]) /, (_, sp, bullet) => `${sp}${CYAN}•${R} `);
      line = line.replace(/^(\s*)(\d+)\. /,  (_, sp, n)     => `${sp}${DIM}${n}.${R} `);

      // ── inline styles ──────────────────────────────────────────────────
      // Bold+italic  ***text***
      line = line.replace(/\*{3}(.+?)\*{3}/g, `${BOLD}${ITALIC}$1${R}`);
      // Bold         **text**
      line = line.replace(/\*{2}(.+?)\*{2}/g, `${BOLD}$1${R}`);
      // Italic       *text* or _text_
      line = line.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, `${ITALIC}$1${R}`);
      line = line.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g,       `${ITALIC}$1${R}`);
      // Strikethrough ~~text~~
      line = line.replace(/~~(.+?)~~/g, `${DIM}$1${R}`);
      // Inline code  `code`
      line = line.replace(/`([^`]+)`/g, `${BG_CODE}${YELLOW} $1 ${R}`);

      out.push(line);
    }

    // close any unclosed fence gracefully
    if (inFence) out.push(`${GRAY}└─${R}`);

    return out.join("\n");
  }

  // ── Tool badge ──────────────────────────────────────────────────────────────
  const TOOL_META = {
    recall:              { icon: "⟳", label: "recalling memory",       color: BLUE    },
    remember:            { icon: "✦", label: "saving memory",          color: GREEN   },
    backfill_embeddings: { icon: "⟳", label: "backfilling embeddings", color: GRAY    },
    deduplicate_memories:{ icon: "⟳", label: "deduplicating",          color: GRAY    },
    forget:              { icon: "✕", label: "forgetting memory",      color: RED     },
  };

  function toolBadge(name) {
    const meta  = TOOL_META[name] || { icon: "◆", label: name, color: MAGENTA };
    return `${meta.color}${meta.icon} ${meta.label}${GRAY}…${R}`;
  }

  // ── State ───────────────────────────────────────────────────────────────────
  let inReasoning   = false;
  let answerStarted = false;
  let answerBuffer  = "";   // accumulate full answer for markdown render
  let turnStartMs   = null; // for elapsed time in token footer

  return {
    send(msg) {
      switch (msg.type) {

        // ── stream_start: swallow silently — do NOT print the blank ↳ line ──
        case "stream_start":
          stopSpinner();
          turnStartMs = Date.now();
          break;

        // ── tool use: one clear dim badge, then spinner while waiting ────────
        case "tool":
          stopSpinner();
          process.stdout.write(`\n  ${toolBadge(msg.name)}\n`);
          startSpinner("working");
          break;

        // ── reasoning block ──────────────────────────────────────────────────
        case "reasoning_start":
          stopSpinner();
          if (showReasoning) {
            process.stdout.write(`\n${GRAY}╭─ thinking ${"─".repeat(34)}╮${R}\n`);
            inReasoning = true;
          }
          break;

        case "reasoning_token":
          if (showReasoning && inReasoning)
            process.stdout.write(`${GRAY}${msg.text}${R}`);
          break;

        case "reasoning_done":
          if (inReasoning) {
            if (showReasoning) process.stdout.write(`\n${GRAY}╰${"─".repeat(46)}╯${R}\n`);
            inReasoning = false;
          }
          break;

        // ── answer tokens: buffer silently, render on stream_end ─────────────
        case "token":
          stopSpinner();
          if (!answerStarted) {
            answerStarted = true;
          }
          answerBuffer += msg.text;
          break;

        case "retract":
          answerBuffer = "";
          answerStarted = false;
          break;

        // ── turn complete: NOW render the buffered answer ─────────────────────
        case "stream_end": {
          stopSpinner();
          const hadAnswer = answerStarted && Boolean(answerBuffer.trim());
          if (hadAnswer) {
            // In round-table mode agent_id identifies the speaker (α/β vs single A)
            const isRt = Boolean(msg.agent_id);
            const label = msg.agent_id === "verifier"
              ? `${MAGENTA}${BOLD}β:${R}`
              : isRt ? `${CYAN}${BOLD}α:${R}` : `${CYAN}${BOLD}A:${R}`;
            const rendered = renderMarkdown(answerBuffer.trimEnd());
            process.stdout.write(`\n${label}\n${rendered}\n`);
            if (msg.usage) {
              const { input_tokens: inn = 0, output_tokens: out = 0, thinking_tokens: think = 0 } = msg.usage;
              const elapsed = turnStartMs ? ((Date.now() - turnStartMs) / 1000).toFixed(1) : null;
              const parts = [
                inn   ? `${inn.toLocaleString()} in`      : null,
                out   ? `${out.toLocaleString()} out`     : null,
                think ? `${think.toLocaleString()} think` : null,
                elapsed ? `${elapsed}s` : null,
              ].filter(Boolean);
              if (parts.length) process.stdout.write(`${GRAY}  [${parts.join(" · ")}]${R}\n`);
            }
            process.stdout.write("\n");
            turnStartMs = null;
          } else {
            // Tool-decision phase: model thought but produced no text yet — keep
            // the spinner going so the user sees activity rather than silence.
            startSpinner("working");
          }
          answerStarted = false;
          answerBuffer  = "";
          inReasoning   = false;
          // In round-table mode each agent emits stream_end — only the final
          // roundtable_agreed / roundtable_no_agreement / roundtable_aborted
          // event calls onTurnDone(). For single-agent turns, call it here.
          if (!msg.agent_id) onTurnDone();
          break;
        }

        case "thinking":
          startSpinner("thinking");
          break;

        case "error":
          stopSpinner();
          process.stdout.write(`\n${RED}✖ error: ${msg.text}${R}\n\n`);
          answerStarted = false;
          answerBuffer  = "";
          onTurnDone();
          break;

        // ── P0: tool budget exhausted ────────────────────────────────────────
        case "tool_budget_exhausted":
          stopSpinner();
          process.stdout.write(
            `\n${RED}✖ tool budget exhausted${R} ${GRAY}(${msg.count} failures: ${(msg.kinds || []).join(", ")})${R}\n`
          );
          break;

        // ── P0: generated file ───────────────────────────────────────────────
        case "generated_file":
          stopSpinner();
          process.stdout.write(
            `\n${GREEN}↓ generated:${R} ${msg.filename}${msg.sizeKb ? ` ${GRAY}(${msg.sizeKb} KB)${R}` : ""}\n`
          );
          break;

        // ── P0: delete confirmation pending ─────────────────────────────────
        case "delete_confirm_pending":
          stopSpinner();
          process.stdout.write(
            `\n${YELLOW}⚠ delete confirmation required${R}\n` +
            `  ${GRAY}path:${R}  ${msg.path}\n` +
            `  ${GRAY}token:${R} ${BOLD}${msg.token}${R}\n` +
            `  ${DIM}Reply with the token above to confirm deletion.${R}\n`
          );
          break;

        // ── P0: context trimmed ──────────────────────────────────────────────
        case "context_trimmed":
          process.stdout.write(
            `\n${GRAY}✂ dropped ${msg.dropped} old message${msg.dropped !== 1 ? "s" : ""} (${msg.pct}% pressure)${R}\n`
          );
          break;

        // ── P1: context pressure warnings ───────────────────────────────────
        case "context_warning":
          process.stdout.write(
            `\n${YELLOW}⚠ context: ${msg.pct}% used${R}\n`
          );
          break;

        case "context_handoff_suggested":
          process.stdout.write(
            `\n${YELLOW}⟳ context: ${msg.pct}% — consider "summarize" or "/handoff"${R}\n`
          );
          break;

        case "context_summarize_suggested":
          process.stdout.write(
            `\n${YELLOW}⚡ context: ${msg.pct}% — auto-summarizing…${R}\n`
          );
          break;

        // ── P1: per-tool start / result ──────────────────────────────────────
        case "tool_start":
          process.stdout.write(
            `\n  ${GRAY}[${msg.seq}] ${MAGENTA}▶ ${msg.name}${R}${msg.arg ? `  ${DIM}${msg.arg}${R}` : ""}\n`
          );
          break;

        case "tool_result": {
          const ms   = msg.ms != null ? ` ${GRAY}${msg.ms}ms${R}` : "";
          const icon = msg.ok ? `${GREEN}✓${R}` : `${RED}✗${R}`;
          const summ = msg.summary ? `  ${DIM}${msg.summary}${R}` : "";
          process.stdout.write(`  ${GRAY}[${msg.seq}]${R} ${icon} ${msg.name}${ms}${summ}\n`);
          break;
        }

        // ── P1: skills matched ───────────────────────────────────────────────
        case "skills_matched": {
          const names = (msg.skills || []).map(s => s.name || s).join(", ");
          if (names) process.stdout.write(`\n${GRAY}  ⚡ skills: ${names}${R}\n`);
          break;
        }

        // ── P1: inline recall result ─────────────────────────────────────────
        case "recall_result":
          if (msg.text) process.stdout.write(`\n${BLUE}  ⟳ recalled:${R} ${DIM}${msg.text}${R}\n`);
          break;

        // ── P1: expiring memory chip ─────────────────────────────────────────
        case "ttl_chip":
          process.stdout.write(
            `\n${GRAY}  ⏱ memory "${msg.title}" expires ${msg.expires_at}${R}\n`
          );
          break;

        // ── informational: context summarized ────────────────────────────────
        case "context_summarized":
          stopSpinner();
          if (msg.ok) {
            process.stdout.write(`\n${GREEN}  ✓ summarized${msg.saved ? " and saved to memory" : ""}${R}\n\n`);
          } else {
            process.stdout.write(`\n${YELLOW}  ⚠ summarize: ${msg.reason}${R}\n\n`);
          }
          onTurnDone();
          break;

        // ── informational: handoff written ───────────────────────────────────
        case "handoff_written":
          stopSpinner();
          if (msg.ok) {
            process.stdout.write(`\n${GREEN}  ✓ handoff written:${R} ${msg.path}\n\n`);
          } else {
            process.stdout.write(`\n${YELLOW}  ⚠ handoff: ${msg.reason}${R}\n\n`);
          }
          onTurnDone();
          break;

        // ── informational: suggestions saved ────────────────────────────────
        case "suggestions_saved":
          process.stdout.write(
            `\n${GRAY}  ✦ ${msg.saved}/${msg.total} suggestion${msg.total !== 1 ? "s" : ""} saved${R}\n`
          );
          break;

        case "tool_count":
          if (msg.count > 0)
            process.stdout.write(`${GRAY}  ◆ ${msg.count} tool${msg.count !== 1 ? "s" : ""} active${R}\n`);
          break;

        case "startup_breakdown": {
          const skillNames = (msg.skills || []).map(s => s.name).join(", ");
          const parts = [`identity: ~${msg.identity}t`];
          if (skillNames) parts.push(`skills: ${skillNames}`);
          process.stdout.write(`${GRAY}  [${parts.join(" · ")}]${R}\n`);
          break;
        }

        // ── informational: session events ────────────────────────────────────
        case "session_created":
        case "session_resumed":
        case "paths_updated":
          break; // silently acknowledge

        // ── round-table events ───────────────────────────────────────────────
        case "roundtable_phase": {
          const PHASE_LABEL = { answer: "Answer", review: "Review", revise: "Revise" };
          const label = PHASE_LABEL[msg.phase] ?? msg.phase;
          const agent = msg.agent_id === "verifier" ? `${MAGENTA}β${R}` : `${CYAN}α${R}`;
          process.stdout.write(`\n${GRAY}[${"─".repeat(4)} ${label} — ${agent} ${"─".repeat(4)}]${R}\n`);
          break;
        }

        case "roundtable_agreed":
          stopSpinner();
          process.stdout.write(`\n${GREEN}${BOLD}✓ Consensus reached${R} ${GRAY}(${msg.rounds} turn${msg.rounds !== 1 ? "s" : ""})${R}\n`);
          onTurnDone();
          break;

        case "roundtable_no_agreement": {
          stopSpinner();
          process.stdout.write(`\n${YELLOW}${BOLD}⚠ No consensus${R} ${GRAY}(${msg.rounds} turn${msg.rounds !== 1 ? "s" : ""})${R}\n`);
          for (const pos of (msg.positions ?? [])) {
            const label = pos.agent_id === "verifier" ? `${MAGENTA}β${R}` : `${CYAN}α${R}`;
            if (pos.text) process.stdout.write(`\n${label}\n${renderMarkdown(pos.text.trimEnd())}\n`);
          }
          process.stdout.write("\n");
          onTurnDone();
          break;
        }

        case "roundtable_error":
          stopSpinner();
          process.stdout.write(
            `\n${RED}✖ agent ${msg.agent_id} failed (${msg.phase}): ${msg.message}${R}\n`
          );
          onTurnDone();
          break;

        case "roundtable_aborted":
          stopSpinner();
          process.stdout.write(`\n${GRAY}↩ round-table aborted after ${msg.rounds} turn${msg.rounds !== 1 ? "s" : ""}${R}\n\n`);
          onTurnDone();
          break;

        // silently swallow browser-only events
        case "status":
        case "provider":
        case "memories":
        case "deleted":
          break;

        // ── fallback: unknown events ─────────────────────────────────────────
        default:
          process.stdout.write(`${GRAY}  [event: ${msg.type}]${R}\n`);
          break;
      }
    },
  };
}