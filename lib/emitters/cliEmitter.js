
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

  return {
    send(msg) {
      switch (msg.type) {

        // ── stream_start: swallow silently — do NOT print the blank ↳ line ──
        case "stream_start":
          stopSpinner();
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
          // nothing to erase in terminal — buffer handles it
          break;

        // ── turn complete: NOW render the buffered answer ─────────────────────
        case "stream_end":
          stopSpinner();
          if (answerStarted && answerBuffer.trim()) {
            const rendered = renderMarkdown(answerBuffer.trimEnd());
            process.stdout.write(`\n${CYAN}${BOLD}A:${R}\n${rendered}\n`);
          }
          process.stdout.write("\n");
          answerStarted = false;
          answerBuffer  = "";
          inReasoning   = false;
          onTurnDone();
          break;

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

        // silently swallow browser-only events
        case "status":
        case "provider":
        case "memories":
        case "deleted":
          break;
      }
    },
  };
}