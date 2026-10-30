// lib/terminal/confirm.js
// Transport-neutral confirmation / interrupt interaction layer (#539, P1).
//
// A consequential tool call does not execute on the model's word. tool-hooks.js
// emits `action_confirm_pending` with a one-shot token, and the interrupt
// service additionally persists the request so it survives a reload — the
// server replays those as `interrupts` on connect. The browser renders both and
// answers with `confirm_action` / `interrupt_decision`.
//
// The terminal had neither. `cliEmitter` printed `[event: action_confirm_pending]`
// without even the token, so a write/delete/database/index/template action could
// not be finished at all: not approved, not rejected, not visible. This module
// is the missing half, and it is deliberately free of any transport:
//
//   • a store of what is awaiting a decision, numbered for reference
//   • renderers that turn each event into terminal text
//   • a parser for the user's answer
//
// proxy.js answers over the WebSocket; standalone.js answers by calling the tool
// with its confirmation token in-process. Neither one duplicates tool-specific
// confirmation logic — that stays in lib/routes/api-interrupts.js, behind the
// same handlers the browser uses.

import { R, BOLD, DIM, GRAY, GREEN, RED, YELLOW, CYAN } from "../utils/chat-utils.js";

/** The decisions the server's interrupt service accepts. */
export const DECISIONS = ["approve", "reject", "respond", "edit"];

/** An ephemeral confirm token only ever runs or is dropped. */
const CONFIRM_DECISIONS = ["approve", "reject"];

// Token shapes minted by tool-hooks.js. Kept in sync with the same literal in
// lib/emitters/handlers/ws/interrupts.js, which validates them server-side.
const TOKEN_RE = /^(?:iss|del|wr|db|idx|tpl)_[a-z0-9]+$/;
const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is this word a reference to a pending item rather than the start of free
 * text? A bare index, a confirm token, or a durable interrupt's UUID. Anything
 * else — including an English word — is treated as the message body, so
 * `/respond use the other path` does not lose its first word.
 *
 * @param {string} word
 * @returns {boolean}
 */
export function looksLikeRef(word) {
  if (!word) return false;
  return /^\d+$/.test(word) || TOKEN_RE.test(word) || UUID_RE.test(word);
}

/**
 * Shape an `action_confirm_pending` event into a pending entry.
 * @param {object} msg
 * @returns {object}
 */
export function toConfirmEntry(msg) {
  return {
    kind: "confirm",
    token: msg.token,
    tool: msg.tool,
    label: msg.label || "Confirm action",
    summary: msg.summary || "",
    destructive: Boolean(msg.destructive),
    allowed: CONFIRM_DECISIONS,
  };
}

/**
 * Shape an `interrupts` event's rows into pending entries. A row that arrives
 * without `allowedDecisions` falls back to approve/reject rather than offering
 * every decision: over-offering would hand the user a command the service then
 * refuses.
 *
 * @param {object[]} rows
 * @returns {object[]}
 */
export function toInterruptEntries(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => ({
    kind: "interrupt",
    id: row.id,
    tool: row.tool,
    summary: summarizeArguments(row.arguments),
    args: row.arguments ?? null,
    destructive: row.tool === "delete_file" || row.tool === "db_execute",
    allowed: (Array.isArray(row.allowedDecisions) && row.allowedDecisions.length)
      ? row.allowedDecisions.filter(d => DECISIONS.includes(d))
      : CONFIRM_DECISIONS,
  }));
}

/**
 * Holds what is awaiting the user's decision, in one numbered list across both
 * kinds. `action_confirm_pending` is a single live proposal (the agent stops its
 * turn on it), while `interrupts` is the server's full replay of durable pending
 * rows and therefore replaces the previous list wholesale.
 */
export function createPendingDecisions() {
  /** @type {object|null} */
  let confirm = null;
  /** @type {object[]} */
  let interrupts = [];

  return {
    /** @param {object} msg an `action_confirm_pending` event */
    setConfirm(msg) { confirm = toConfirmEntry(msg); },

    /** @param {object[]} rows serialized interrupts from an `interrupts` event */
    setInterrupts(rows) { interrupts = toInterruptEntries(rows); },

    /** Everything awaiting a decision; the live confirm proposal leads. */
    list() {
      return confirm ? [confirm, ...interrupts] : [...interrupts];
    },

    /** Forget one entry once it has been decided. */
    remove(entry) {
      if (!entry) return;
      if (entry.kind === "confirm") { confirm = null; return; }
      interrupts = interrupts.filter(i => i.id !== entry.id);
    },

    clear() { confirm = null; interrupts = []; },

    /**
     * Find the entry a decision command refers to.
     *
     * With no reference and exactly one pending entry, that entry is meant —
     * the common case, where `/approve` on its own must just work. With no
     * reference and several pending, the command is ambiguous and is refused
     * rather than guessed at: approving the wrong write is not recoverable.
     *
     * @param {string|undefined} ref index (1-based), token, or interrupt id
     * @returns {{ entry: object|null, error: string|null }}
     */
    resolve(ref) {
      const entries = confirm ? [confirm, ...interrupts] : [...interrupts];
      if (entries.length === 0) return { entry: null, error: "Nothing is awaiting a decision." };

      if (ref === undefined || ref === "") {
        if (entries.length === 1) return { entry: entries[0], error: null };
        return {
          entry: null,
          error: `${entries.length} items are awaiting a decision — name one, e.g. /approve 1 (see /pending).`,
        };
      }

      // An index when it names one, and otherwise not an index at all: an
      // interrupt id is a UUID, so a prefix of one can be all digits
      // ("11111111-…"). Reading that as item 11,111,111 and refusing would make
      // a legitimate id unusable, so an out-of-range number falls through to
      // prefix matching rather than erroring there.
      if (/^\d+$/.test(ref)) {
        const entry = entries[Number(ref) - 1];
        if (entry) return { entry, error: null };
      }

      const lower = ref.toLowerCase();
      const matches = entries.filter(e => (e.kind === "confirm" ? e.token : e.id).toLowerCase().startsWith(lower));
      if (matches.length === 1) return { entry: matches[0], error: null };
      if (matches.length === 0) return { entry: null, error: `No pending item matching "${ref}" (see /pending).` };
      return { entry: null, error: `"${ref}" matches ${matches.length} pending items — use the number instead.` };
    },
  };
}

/**
 * One line describing what a durable interrupt would do. The arguments bag is
 * tool-shaped, so the fields worth showing differ; path/query/folder cover
 * every tool in CONFIRMABLE_TOOLS and anything else degrades to the key list
 * rather than dumping a wall of JSON into the prompt.
 *
 * @param {object|null} args
 * @returns {string}
 */
export function summarizeArguments(args) {
  if (!args || typeof args !== "object") return "";
  const first = args.path ?? args.sql ?? args.query ?? args.folder ?? args.title ?? args.name;
  if (typeof first === "string") return first.length > 160 ? `${first.slice(0, 157)}…` : first;
  const keys = Object.keys(args);
  return keys.length ? `{ ${keys.join(", ")} }` : "";
}

/** The `approve / reject / …` hint line for one entry. */
function choicesLine(allowed, ref) {
  const suffix = ref == null ? "" : ` ${ref}`;
  return allowed.map(d => {
    if (d === "respond") return `${BOLD}/respond${R}${suffix} <text>`;
    if (d === "edit")    return `${BOLD}/edit${R}${suffix} <json>`;
    return `${BOLD}/${d}${R}${suffix}`;
  }).join(`${GRAY}  ·  ${R}`);
}

/**
 * Render a live `action_confirm_pending` proposal: the exact tool, what it
 * targets, and how to answer. The token is printed because it is also the
 * manual fallback — a user on an older client can still reply with it.
 *
 * @param {object} entry from createPendingDecisions().list()
 * @returns {string}
 */
export function renderConfirmPending(entry) {
  const mark = entry.destructive ? `${RED}⚠${R}` : `${YELLOW}⚠${R}`;
  const lines = [
    "",
    `${mark} ${BOLD}confirmation required${R}${entry.destructive ? ` ${RED}(destructive)${R}` : ""}`,
    `  ${GRAY}action:${R} ${entry.label}`,
    `  ${GRAY}tool:${R}   ${entry.tool}`,
  ];
  if (entry.summary) {
    for (const line of entry.summary.split("\n")) lines.push(`  ${GRAY}│${R} ${DIM}${line}${R}`);
  }
  lines.push(`  ${GRAY}token:${R}  ${DIM}${entry.token}${R}`);
  lines.push(`  ${choicesLine(entry.allowed, null)}`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Render the server's replay of durable pending interrupts. Silent when there
 * are none: this event fires on every connect and after every decision, and a
 * "nothing pending" banner on each one would be noise.
 *
 * @param {object[]} entries interrupt entries, in list() order
 * @param {number} offset how many earlier entries the numbering must skip
 * @returns {string}
 */
export function renderInterrupts(entries, offset = 0) {
  if (!entries.length) return "";
  const lines = [
    "",
    `${YELLOW}⚠ ${entries.length} action${entries.length === 1 ? "" : "s"} awaiting your decision${R}`,
  ];
  entries.forEach((entry, i) => {
    const n = offset + i + 1;
    lines.push(`  ${CYAN}${n}.${R} ${BOLD}${entry.tool}${R}${entry.summary ? `  ${DIM}${entry.summary}${R}` : ""}`);
    lines.push(`     ${choicesLine(entry.allowed, n)}`);
  });
  lines.push("");
  return lines.join("\n");
}

/**
 * Render the outcome of a decision. `interrupt_decided` carries the decision and
 * whatever the executed tool returned; the tool's own text is left to the
 * following `stream_end`, so this stays a one-line receipt.
 *
 * @param {object} msg an `interrupt_decided` event
 * @returns {string}
 */
export function renderInterruptDecided(msg) {
  const tool = msg.interrupt?.tool ?? "action";
  if (msg.decision === "reject")  return `\n${GRAY}✕ rejected — ${tool} did not run${R}\n`;
  if (msg.decision === "respond") return `\n${GRAY}✎ response recorded — ${tool} did not run${R}\n`;
  return `\n${GREEN}✓ ${msg.decision === "edit" ? "approved with edits" : "approved"}${R} ${GRAY}— ${tool}${R}\n`;
}

/** Render the `/pending` listing. */
export function renderPendingList(entries) {
  if (!entries.length) return `\n${GRAY}  nothing is awaiting a decision${R}\n\n`;
  const lines = [""];
  entries.forEach((entry, i) => {
    const ref = entry.kind === "confirm" ? entry.token : entry.id;
    lines.push(`  ${CYAN}${i + 1}.${R} ${BOLD}${entry.tool}${R} ${GRAY}${ref}${R}`);
    if (entry.summary) lines.push(`     ${DIM}${entry.summary.split("\n")[0]}${R}`);
    lines.push(`     ${choicesLine(entry.allowed, i + 1)}`);
  });
  lines.push("");
  return lines.join("\n");
}

/**
 * Turn a decision command into something a client can act on, doing every
 * check that is not transport-specific: which item is meant, whether that item
 * accepts the decision, and whether the payload parses.
 *
 * Both terminal clients route through this so neither re-implements the rules,
 * and the rules themselves can be tested without a socket or an agent. What is
 * left to the caller is only the delivery: proxy.js sends a WS message,
 * standalone.js calls the tool in-process.
 *
 * @param {ReturnType<typeof createPendingDecisions>} pending
 * @param {string} cmd the command with its leading "/" already stripped
 * @returns {{ action: "list" }
 *          | { action: "error", message: string }
 *          | { action: "decide", entry: object, decision: string, payload: string, editedArguments: object|undefined }}
 */
export function planDecision(pending, cmd) {
  const parsed = parseDecisionCommand(cmd);
  if (!parsed) return { action: "error", message: `Not a decision command: ${cmd}` };
  const { decision, ref, payload } = parsed;
  if (decision === "pending") return { action: "list" };

  const { entry, error } = pending.resolve(ref);
  if (error) return { action: "error", message: error };

  if (!entry.allowed.includes(decision)) {
    const offer = entry.allowed.map(d => `/${d}`).join(" or ");
    return { action: "error", message: `${entry.tool} does not accept /${decision} — use ${offer}.` };
  }

  if (decision === "respond" && !payload) {
    return { action: "error", message: "/respond needs the text to send back, e.g. /respond use the other path" };
  }

  let editedArguments;
  if (decision === "edit") {
    if (!payload) {
      return { action: "error", message: '/edit needs the replacement arguments as JSON, e.g. /edit {"path":"notes.md"}' };
    }
    try {
      editedArguments = JSON.parse(payload);
    } catch (err) {
      return { action: "error", message: `/edit arguments are not valid JSON: ${err.message}` };
    }
    if (editedArguments === null || typeof editedArguments !== "object" || Array.isArray(editedArguments)) {
      return { action: "error", message: "/edit arguments must be a JSON object." };
    }
  }

  return { action: "decide", entry, decision, payload, editedArguments };
}

/**
 * The WebSocket message that carries a decision to the server, or null when the
 * decision needs no message at all.
 *
 * Rejecting a live `action_confirm_pending` proposal is that null case. The
 * token is one-shot and nothing executes until it is redeemed, so dropping it
 * IS the rejection — there is no `reject_action` message to send, and inventing
 * one would be a protocol addition the server does not accept. A durable row
 * behind that token stays pending and comes back in the next `interrupts`
 * replay, where /reject goes through interrupt_decision properly.
 *
 * Returning the shape from here rather than building it inline keeps the wire
 * contract testable without a socket, and is checked against the types
 * wsHandler.js actually accepts in protocol-parity.test.js.
 *
 * @param {object} plan a `planDecision` result with action "decide"
 * @returns {object|null}
 */
export function buildDecisionMessage(plan) {
  const { entry, decision, payload, editedArguments } = plan;
  if (entry.kind === "confirm") {
    if (decision === "reject") return null;
    return { type: "confirm_action", token: entry.token, tool: entry.tool };
  }
  return {
    type: "interrupt_decision",
    id: entry.id,
    decision,
    editedArguments,
    response: decision === "respond" ? payload : undefined,
  };
}

/** Is this a decision command? Used to route before the generic unknown-command path. */
export function isDecisionCommand(cmd) {
  return /^(approve|reject|respond|edit|pending)\b/i.test((cmd || "").trim());
}

/**
 * Parse a decision command into its parts. Returns null when `cmd` is not one,
 * so a caller can fall through to the other command predicates.
 *
 * `/respond 2 use the other path` splits as ref `2` + text; `/respond use the
 * other path` has no ref and keeps every word of the text (see looksLikeRef).
 *
 * @param {string} cmd the command with its leading "/" already stripped
 * @returns {{ decision: string, ref: string|undefined, payload: string }|null}
 */
export function parseDecisionCommand(cmd) {
  const trimmed = (cmd || "").trim();
  const m = trimmed.match(/^(approve|reject|respond|edit|pending)\b\s*([\s\S]*)$/i);
  if (!m) return null;
  const decision = m[1].toLowerCase();
  let rest = m[2].trim();
  let ref;
  const firstSpace = rest.search(/\s/);
  const firstWord = firstSpace === -1 ? rest : rest.slice(0, firstSpace);
  // `respond` and `edit` need a payload, so their single argument is the
  // payload, not a reference: `/edit 42` is a (bad) JSON body and must be
  // reported as such, while `/edit 1 {…}` names item 1. `/approve 1` has
  // nothing to follow the reference, so there the bare word is allowed to be
  // one.
  const refNeedsFollowingText = decision === "respond" || decision === "edit";
  if (looksLikeRef(firstWord) && !(refNeedsFollowingText && firstSpace === -1)) {
    ref = firstWord;
    rest = firstSpace === -1 ? "" : rest.slice(firstSpace).trim();
  }
  return { decision, ref, payload: rest };
}
