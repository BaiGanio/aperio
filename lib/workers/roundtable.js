import { join } from "path";
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import { makeWsEmitter } from "../emitters/wsEmitter.js";
import logger from "../helpers/logger.js";

const DEFAULT_MAX_ROUNDS = 3;
const ROUNDTABLES_DIR = join(process.cwd(), "var/roundtables");

const PHASE_LABELS = {
  answer:   "Answer",
  review:   "Review",
  revise:   "Revision",
  rereview: "Re-review",
};

/**
 * Render an accumulated round-table transcript to a human-readable markdown
 * document and append it under <project>/var/roundtables/.
 *
 * One file per session (named by sessionId). The first discussion in a session
 * writes a session header; subsequent discussions are appended. Falls back to a
 * timestamp+slug filename when no sessionId is provided.
 *
 * Best-effort: a write failure is logged but never breaks the round-table.
 *
 * @param {object} rec
 * @param {string} [rec.sessionId]
 * @param {string} rec.userText
 * @param {Array<{phase:string,agentId:string,name:string,model:string,character?:string,text:string}>} rec.turns
 * @param {{primary:object,verifier:object}} rec.agents - createAgent instances (for identity labels).
 * @param {"agreed"|"no_agreement"|"interrupted"} rec.verdict
 * @param {string} [rec.agreedText]
 * @returns {string|null} the written path, or null on failure.
 */
export function writeRoundtableRecord({ sessionId, userText, turns, agents, verdict, agreedText }) {
  // Never touch disk under tests — the record is a best-effort side effect, not a
  // return value callers depend on. Belt-and-suspenders alongside the test-side
  // fs stubs so the suite can never pollute var/roundtables/.
  if (process.env.NODE_ENV === "test") return null;

  const filePath = sessionId
    ? join(ROUNDTABLES_DIR, `aperio-roundtable-${sessionId}.md`)
    : (() => {
        const iso  = new Date().toISOString().replace(/[:.]/g, "-");
        const slug = String(userText).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "discussion";
        return join(ROUNDTABLES_DIR, `aperio-roundtable-${iso}-${slug}.md`);
      })();

  const agentLabel = (agent, role) => {
    const character = agent?.character ? ` — ${agent.character}` : "";
    const who = agent ? `${agent.provider.name} (${agent.provider.model})` : role;
    return `${role === "primary" ? "Agent A" : "Agent B"}${character} · ${who}`;
  };

  const verdictLine =
    verdict === "agreed"      ? "✅ Consensus reached"
    : verdict === "interrupted" ? "⚠️ Interrupted before consensus"
    : "❌ No consensus";

  const sections = turns.flatMap((t, i) => {
    const phaseLabel = PHASE_LABELS[t.phase] ?? t.phase;
    const charTag = t.character ? ` (${t.character})` : "";
    const agentTag = t.agentId === "primary" ? "Agent A" : "Agent B";
    const modelTag = t.model ? ` [${t.model}]` : "";
    return [`### ${i + 1}. ${agentTag}${charTag}${modelTag} — ${phaseLabel}`, ``, String(t.text).trim(), ``];
  });

  const discussionDate = new Date().toISOString();
  const discussion = [
    ``,
    `---`,
    ``,
    `## Discussion — ${discussionDate}`,
    ``,
    `- **Verdict:** ${verdictLine} (${turns.length} turns)`,
    ``,
    `### Question`,
    ``,
    String(userText).trim(),
    ``,
    ...sections,
    ...(verdict === "agreed" && agreedText
      ? [`### Final consensus`, ``, String(agreedText).trim(), ``]
      : []),
  ].join("\n");

  try {
    mkdirSync(ROUNDTABLES_DIR, { recursive: true });
    if (!existsSync(filePath)) {
      const sessionHeader = [
        `# Round-table session${sessionId ? ` ${sessionId}` : ""}`,
        ``,
        `- **Session ID:** ${sessionId ?? "n/a"}`,
        `- **Agent A:** ${agentLabel(agents.primary, "primary")}`,
        `- **Agent B:** ${agentLabel(agents.verifier, "verifier")}`,
      ].join("\n");
      writeFileSync(filePath, sessionHeader, "utf-8");
    }
    appendFileSync(filePath, discussion, "utf-8");
    return filePath;
  } catch (err) {
    logger.error(`[roundtable] failed to write discussion record: ${err.message}`);
    return null;
  }
}
// Leading-AGREED detector — tolerates markdown bold wrappers like `**AGREED:**`.
// The `\*{0,2}` slots before and after `AGREED:` consume opening/closing `**`.
const AGREED_LEAD_RE = /^\s*\*{0,2}\s*agreed\s*:\s*\*{0,2}\s*/i;
const AGREED_ANYWHERE_RE = /\bagreed\b/i;

/**
 * Detect whether a peer agent's reply is an explicit agreement.
 *
 * Rule (from plan §4.3): the FIRST non-whitespace token must be `AGREED:`
 * (case-insensitive, optional leading `**`). Anything else is an objection.
 * If "AGREED" appears mid-text but not at the start, the reply is `malformed`
 * — the orchestrator may re-prompt the agent once with stricter instructions.
 *
 * @param {string} text
 * @returns {{ agreed: boolean, malformed: boolean, body: string }}
 */
export function parseAgreement(text) {
  if (text == null || typeof text !== "string") return { agreed: false, malformed: false, body: "" };
  const trimmed = text.trim();
  if (!trimmed) return { agreed: false, malformed: false, body: "" };
  if (AGREED_LEAD_RE.test(trimmed)) {
    const body = trimmed.replace(AGREED_LEAD_RE, "").replace(/\*+\s*$/, "").trim();
    return { agreed: true, malformed: false, body };
  }
  if (AGREED_ANYWHERE_RE.test(trimmed)) {
    return { agreed: false, malformed: true, body: trimmed };
  }
  return { agreed: false, malformed: false, body: trimmed };
}

/**
 * Flatten a peer agent's reply into plain text suitable for embedding in the
 * other agent's prompt. Strips `tool_use` and `tool_result` blocks so Anthropic
 * doesn't 400 on dangling tool_use IDs from the cross-agent transcript view.
 *
 * @param {string|Array<{type:string,text?:string}>} reply
 * @returns {string}
 */
export function foldReplyToPlainText(reply) {
  if (reply == null) return "";
  if (typeof reply === "string") return reply.trim();
  if (Array.isArray(reply)) {
    return reply
      .filter(b => b?.type === "text" && typeof b.text === "string")
      .map(b => b.text)
      .join("\n")
      .trim();
  }
  if (typeof reply === "object" && typeof reply.text === "string") return reply.text.trim();
  return String(reply).trim();
}

function quoteBlock(text) {
  return String(text ?? "").replace(/\r?\n/g, "\n> ");
}

/**
 * Detect when an agent's reply is actually a provider/transport error that
 * leaked through `runAgentLoop` as content. Two shapes occur in the wild:
 *
 *  - The OpenAI-compatible error envelope returned verbatim by the ollama loop
 *    when `response.ok` is false:
 *    `{"error":{"message":"...","type":"invalid_request_error",...}}`
 *  - A request-layer fallback (timeout/network) wrapped in the ⚠️ marker the
 *    loop also emits via `stream_end`.
 *
 * Returns a short, human-readable error string when detected, otherwise null.
 */
export function detectProviderError(reply) {
  if (typeof reply !== "string") return null;
  const trimmed = reply.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("⚠️")) return trimmed.replace(/^⚠️\s*/, "").trim();
  if (trimmed.startsWith("{") && /"error"\s*:/.test(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed);
      const msg = parsed?.error?.message || parsed?.error || parsed?.message;
      if (msg) return String(msg).trim();
    } catch { /* not JSON — fall through */ }
  }
  return null;
}

export function buildAnswerPrompt(userText) {
  return `PHASE: ANSWER\n${userText}`;
}
export function buildReviewPrompt(userText, a1) {
  return `PHASE: REVIEW\nOriginal user question:\n> ${quoteBlock(userText)}\n\nAgent A's answer:\n> ${quoteBlock(a1)}`;
}
export function buildRevisePrompt(userText, lastA, lastB) {
  return `PHASE: REVISE\nOriginal user question:\n> ${quoteBlock(userText)}\n\nYour previous answer:\n> ${quoteBlock(lastA)}\n\nAgent B's objections:\n> ${quoteBlock(lastB)}`;
}
export function buildRereviewPrompt(userText, priorObjections, revisedA) {
  return `PHASE: REREVIEW\nOriginal user question:\n> ${quoteBlock(userText)}\n\nYour prior objections:\n> ${quoteBlock(priorObjections)}\n\nAgent A's revised answer:\n> ${quoteBlock(revisedA)}`;
}

/**
 * Wrap a PHASE-prefixed text prompt together with any user-uploaded attachment
 * blocks (images, inlined text files, PDFs, etc.) into the multi-block
 * `content` format providers expect.
 *
 * Used for the first turn of each agent (ANSWER for A, REVIEW for B) so both
 * agents see what the user uploaded. Subsequent rounds re-use each agent's
 * own message buffer, where the attachments already live, so we don't repeat.
 *
 * wsHandler builds `userContent` as `[{type:"text", text:data.text}, ...attBlocks]`.
 * The first block is the user's typed text, which is already folded into
 * `promptText` (with PHASE: prefix), so we skip it. Everything after is real
 * attachment payload — text-file inlines, image data, etc. — and must be kept
 * regardless of block type. (Earlier versions filtered by `type !== "text"`,
 * which silently dropped inlined json/md/code/docx/pdf/pptx file content.)
 *
 * If `userContent` is a string (no attachments), we just return the prompt as
 * a string — preserves the lighter back-compat format.
 */
export function withUserAttachments(promptText, userContent) {
  if (!Array.isArray(userContent)) return promptText;
  const attachmentBlocks = userContent.slice(1).filter(Boolean);
  if (attachmentBlocks.length === 0) return promptText;
  return [{ type: "text", text: promptText }, ...attachmentBlocks];
}

/**
 * Run a two-agent round-table for a single user turn.
 *
 * Protocol (plan §4): strictly sequential. A answers → B reviews → A revises →
 * B re-reviews → … until explicit AGREED, `maxRounds` rounds elapsed, or abort.
 *
 * v1 simplifications (documented in `roundtable-deferred-work.md`):
 *  - The strict-format re-prompt on malformed AGREED replies is deferred.
 *    Malformed replies are treated as objections.
 *
 * @param {object} opts
 * @param {object} opts.primary           - Primary agent (Agent A — answerer).
 * @param {object} opts.verifier          - Verifier agent (Agent B — reviewer).
 * @param {string} opts.userText
 * @param {string|Array} [opts.userContent] - Optional message-payload form of the user turn.
 *                                           If an array of content blocks (text + image/etc.),
 *                                           the attachment blocks are propagated to both
 *                                           agents' first turns so they actually see uploads.
 *                                           Defaults to `userText` (string form).
 * @param {Array}  opts.sharedTranscript  - wsHandler's `messages`; consensus is appended.
 *                                           The user turn is assumed to already be in this
 *                                           array (with any attachments registered).
 * @param {WebSocket} opts.ws             - Raw socket; orchestrator wraps per-agent.
 * @param {string} [opts.sessionId]       - Session identifier for grouping log files.
 * @param {string} [opts.lang="en"]
 * @param {number} [opts.maxRounds]       - Default from ROUNDTABLE_MAX_ROUNDS env or 3.
 * @param {() => AbortController|null} [opts.getAbort]
 * @param {(AbortController) => void}  [opts.setAbort]
 *
 * @returns {Promise<{agreed:boolean, text?:string, positions?:object, rounds:number, interrupted?:boolean}>}
 */
export async function runRoundTable({
  primary,
  verifier,
  userText,
  userContent = null,
  sharedTranscript,
  ws,
  sessionId = null,
  lang = "en",
  maxRounds = Number(process.env.ROUNDTABLE_MAX_ROUNDS) || DEFAULT_MAX_ROUNDS,
  getAbort = () => null,
  setAbort = () => {},
}) {
  if (!primary || !verifier) throw new Error("runRoundTable requires both primary and verifier agents");
  if (!userText || !String(userText).trim()) throw new Error("runRoundTable requires non-empty userText");

  const baseEmitter = makeWsEmitter(ws);
  const aEmitter    = makeWsEmitter(ws, { agentId: "primary",  persona: primary.persona  ?? "primary"  });
  const bEmitter    = makeWsEmitter(ws, { agentId: "verifier", persona: verifier.persona ?? "verifier" });

  // Each agent has its own message buffer — providers disagree on tool_use ID
  // shape, so a shared buffer would collide. Cross-agent visibility is achieved
  // via the PHASE-tagged user prompts that quote the peer's reply verbatim.
  const aMessages = [];
  const bMessages = [];

  const positions = { primary: "", verifier: "" };
  const transcript = [];
  let lastObjections = "";
  let agentTurns = 0;
  let agreed = false;
  let agreedText = "";

  const aborted = () => Boolean(getAbort()?.signal?.aborted);

  async function turn(agent, msgs, emitter, phase, content) {
    const agentId = agent === primary ? "primary" : "verifier";
    baseEmitter.send({ type: "roundtable_phase", phase, agent_id: agentId });
    msgs.push({ role: "user", content });
    // NOTE: runAgentLoop appends the assistant turn (and any intermediate
    // tool_use / tool_result messages) onto `msgs` itself — we must NOT push
    // an assistant message here or we'd double up. We do, however, fold the
    // returned text to plain text for the *peer agent's* prompts.
    const reply = await agent.runAgentLoop(msgs, emitter, { lang }, getAbort, setAbort);
    agentTurns += 1;
    const folded = foldReplyToPlainText(reply);
    const providerErr = detectProviderError(folded);
    if (providerErr) {
      const err = new Error(providerErr);
      err.roundtableAgentId = agentId;
      err.roundtablePhase = phase;
      throw err;
    }
    transcript.push({
      phase,
      agentId,
      name: agent.provider.name,
      model: agent.provider.model,
      character: agent.character ?? null,
      text: folded,
    });
    return folded;
  }

  const recordDiscussion = (verdict) => {
    if (transcript.length === 0) return;
    writeRoundtableRecord({
      sessionId,
      userText,
      turns: transcript,
      agents: { primary, verifier },
      verdict,
      agreedText,
    });
  };

  try {
    // ── Round 1 ──────────────────────────────────────────────────────────────
    if (aborted()) return _emitAborted(baseEmitter, agentTurns);

    // Pass the user's attachment blocks (if any) into A's first turn so a
    // vision-capable model actually sees uploaded images, and so file/text
    // attachments are folded into A's working buffer.
    const answerContent = withUserAttachments(buildAnswerPrompt(userText), userContent);
    const a1 = await turn(primary, aMessages, aEmitter, "answer", answerContent);
    positions.primary = a1;
    if (aborted()) return _emitAborted(baseEmitter, agentTurns);

    // B also gets the original attachments — otherwise B is only reviewing A's
    // description of the image rather than the image itself.
    const reviewContent = withUserAttachments(buildReviewPrompt(userText, a1), userContent);
    const b1 = await turn(verifier, bMessages, bEmitter, "review", reviewContent);
    positions.verifier = b1;
    lastObjections = b1;

    const b1Parse = parseAgreement(b1);
    if (b1Parse.agreed) { agreed = true; agreedText = b1Parse.body || a1; }

    // ── Subsequent rounds ────────────────────────────────────────────────────
    let lastA = a1;
    let lastB = b1;
    let round = 2;
    while (!agreed && round <= maxRounds && !aborted()) {
      const aN = await turn(primary, aMessages, aEmitter, "revise", buildRevisePrompt(userText, lastA, lastB));
      const aParse = parseAgreement(aN);
      if (aParse.agreed) { agreed = true; agreedText = aParse.body || lastB; break; }
      positions.primary = aN;
      lastA = aN;
      if (aborted()) break;

      const bN = await turn(verifier, bMessages, bEmitter, "rereview", buildRereviewPrompt(userText, lastObjections, lastA));
      const bParse = parseAgreement(bN);
      if (bParse.agreed) { agreed = true; agreedText = bParse.body || lastA; break; }
      positions.verifier = bN;
      lastB = bN;
      lastObjections = bN;
      round += 1;
    }
  } catch (err) {
    if (err?.roundtableAgentId) {
      // Provider rejected the request mid-round — surface as a dedicated
      // event so the UI can show "agent X failed: <reason>" instead of
      // leaking the raw provider envelope into the no-consensus card.
      logger.error(`[roundtable] ${err.roundtableAgentId} provider error during ${err.roundtablePhase}: ${err.message}`);
      baseEmitter.send({
        type: "roundtable_error",
        agent_id: err.roundtableAgentId,
        phase: err.roundtablePhase,
        message: err.message,
        rounds: agentTurns,
      });
      recordDiscussion("interrupted");
      return { agreed: false, positions, rounds: agentTurns, interrupted: true, error: err.message };
    }
    logger.error("[roundtable] orchestrator failed:", err);
    baseEmitter.send({ type: "error", text: `Round-table failed: ${err.message}` });
    recordDiscussion("interrupted");
    return { agreed: false, positions, rounds: agentTurns, interrupted: true };
  }

  if (aborted()) { recordDiscussion("interrupted"); return _emitAborted(baseEmitter, agentTurns); }

  // The user's turn (with any attachments) is already in `sharedTranscript` —
  // wsHandler pushed it before invoking the orchestrator. We only add the
  // assistant turn so summarize / resume_session see a clean (user, assistant)
  // pair instead of a duplicated user message.
  if (agreed) {
    baseEmitter.send({
      type: "roundtable_agreed",
      text: agreedText,
      agents: [
        { id: "primary",  name: primary.provider.name,   model: primary.provider.model },
        { id: "verifier", name: verifier.provider.name,  model: verifier.provider.model },
      ],
      rounds: agentTurns,
    });
    sharedTranscript?.push({ role: "assistant", content: agreedText });
    recordDiscussion("agreed");
    return { agreed: true, text: agreedText, rounds: agentTurns };
  }

  baseEmitter.send({
    type: "roundtable_no_agreement",
    positions: [
      { agent_id: "primary",  text: positions.primary  },
      { agent_id: "verifier", text: positions.verifier },
    ],
    rounds: agentTurns,
  });
  sharedTranscript?.push({
    role: "assistant",
    content: `[Round-table — no consensus after ${agentTurns} turns]\n\n**Agent A:**\n${positions.primary}\n\n**Agent B:**\n${positions.verifier}`,
  });
  recordDiscussion("no_agreement");
  return { agreed: false, positions, rounds: agentTurns };
}

function _emitAborted(emitter, rounds) {
  emitter.send({ type: "roundtable_aborted", rounds });
  return { agreed: false, rounds, interrupted: true };
}
