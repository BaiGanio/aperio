/**
 * lib/agent/turn-planner.js — pure turn analysis (issue #307 Phase 5a, category 1).
 *
 * Extracted from lib/agent/index.js's ensureTurn(): text extraction, slash-skill
 * parsing, keyword tool-profile classification, and skill matching/merging
 * (forced > always-on > keyword > semantic). Deliberately excludes schema-token
 * budget capping (capToolsForProvider) — that stays with tool-profiles.js/index.js
 * since it needs live provider state (contextWindow), not just the turn's text.
 *
 * No closures, no side effects: pendingForcedSkillNames/pendingSemanticSkillNames
 * are consumed by VALUE (the caller in index.js owns resetting its own queues —
 * same "exactly one place owns this state" convention as lib/emitters/handlers/ws/*.js).
 * The "skills_not_found" emit also stays with the caller, which has the emitter.
 */
import { parseSlashSkill, matchSkills, getAlwaysOnSkills } from "../workers/skills.js";
import { isStandaloneVisionRequest } from "../helpers/imageBridge.js";
import {
  SYNTHETIC_USER,
  PREFLIGHT_TOOL_USE,
  TOOL_PROFILES,
  HOST_TOOL_PROFILES,
  FIRST_TURN_TOOLS,
  TOOL_PIN_TURNS,
  SKILL_PIN_TURNS,
  classifyProfiles,
  filterToolsForIntent,
} from "./tool-profiles.js";

export function extractUserText(m) {
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.find(b => b.type === "text")?.text ?? "";
  return "";
}

const RECENT_USER_TURNS = 2;
export function recentUserText(messages, userText) {
  const all = messages
    .filter(m => m.role === "user" && !m[SYNTHETIC_USER])
    .map(extractUserText)
    .filter(Boolean);
  const priors = (all.length > 0 && all[all.length - 1] === userText) ? all.slice(0, -1) : all;
  const window = priors.slice(-(RECENT_USER_TURNS - 1));
  return [...window, userText].filter(Boolean).join(" ");
}

// Names of tools the assistant actually invoked in messages[startIdx..endIdx)
// (a half-open slice between one user turn and the next). Used for BOTH
// `toolUsedAfter` (did this turn use a tool at all) and, since a P2 review
// finding, as half of `carriedToolNames` below (the other half being
// attachedSkillScriptNames, for a skill-added tool that was attached but
// never itself called) — neither `classifyProfiles(text)` nor "what was
// called" alone can recover every tool a historical turn's request actually
// included.
//
// Skips messages marked PREFLIGHT_TOOL_USE (P2 review finding): preflight.js
// injects synthetic assistant tool_use blocks (doc_repos/doc_manifest/
// doc_batch auto-execution) to record a canonical tool exchange in history,
// then withholds those tools' schemas from the actual model request that same
// turn via finalizeTurnTools/preExecutedTools. That withholding is turn-scoped
// (preExecutedTools is a fresh Set every turn) and never touches the
// persisted message, so counting these blocks here would pin schemas into a
// follow-up turn's tool array that llama-server never actually cached for the
// historical turn — the opposite of what the pin exists to protect.
function toolNamesCalled(messages, startIdx, endIdx) {
  const names = new Set();
  for (const m of messages.slice(startIdx, endIdx)) {
    if (m.role !== "assistant" || m[PREFLIGHT_TOOL_USE] || !Array.isArray(m.content)) continue;
    for (const b of m.content) if (b?.type === "tool_use" && b.name) names.add(b.name);
  }
  return names;
}

// Real user turns in message order, mirroring countUserTurns'/recentUserText's
// own filtering (excludes the synthetic greeting so it never seeds sticky
// profiles). `idx` is the message's position in `messages`, used below to scan
// for a tool_use response between one user turn and the next. Stores each
// turn's RAW text, deliberately un-slash-cleaned here — see windowedTextFor,
// which is the one place that decides when cleaning may happen (P2 review
// finding: cleaning per-turn before windowing does not mirror live
// classification, see below).
function realUserTurns(messages) {
  const turns = [];
  messages.forEach((m, idx) => {
    if (m.role !== "user" || m[SYNTHETIC_USER]) return;
    const raw = extractUserText(m);
    if (!raw) return;
    turns.push({ idx, raw });
  });
  return turns;
}

// Reconstructs the same recentUserText-style window (last RECENT_USER_TURNS
// real user turns, joined by a space) a historical turn was ACTUALLY
// classified with when it was live — not just that turn's own message in
// isolation. Intent is often split across turns ("Could you index it?" /
// "the folder I shared"): the second turn's live classification (and
// whatever tool it triggered) saw both messages via the window, so
// reconstructing history from single-message text alone would silently lose
// the profile that tool call should have pinned.
//
// Slash-cleaning must happen AFTER joining the raw window, not before (P2
// review finding): live classification builds `text` by taking the RAW
// `recentUserText` window and running `parseSlashSkill` on the whole joined
// string exactly once — and parseSlashSkill only strips a "/skill" prefix
// when it sits at the very START of the string it's given. A slash command
// on a turn that ISN'T the first in its window (e.g. "/pptx summarize..."
// following an earlier, unrelated turn) is therefore NOT stripped live — the
// literal "pptx" stays in `text` and legitimately triggers file-generate,
// exactly as observed (the turn calls a file-generation tool). Cleaning each
// turn's raw text individually BEFORE joining (the pre-fix behavior here)
// always strips it regardless of position, silently losing that live
// classification result for every later turn's pin/carry reconstruction —
// the exact turn that armed the pin would then look keyword-free in
// hindsight, and the file-generate schemas it earned would drop on the very
// next follow-up. Joining first and cleaning once, like live classification
// does, reproduces both cases correctly: turn 1 (nothing before it in the
// window) still gets its slash stripped, same as today.
function windowedTextFor(turns, i, skillIndex) {
  const start = Math.max(0, i - (RECENT_USER_TURNS - 1));
  const rawWindow = turns.slice(start, i + 1).map(t => t.raw).join(" ");
  return parseSlashSkill(rawWindow, skillIndex).cleanedText;
}

// Pin-for-N-turns tool-profile stability (llamacpp-multiturn-latency plan,
// Step 2): once a turn's assistant response actually calls a tool, keep
// UNIONING (never dropping) profiles for exactly TOOL_PIN_TURNS follow-up
// turns instead of re-classifying the bare window from scratch every turn —
// a continuous tool-using flow (e.g. document-intelligence's propose/confirm
// round trips) re-arms its own pin window on every hop, so the attached tool
// array stays a stable, growing prefix for the flow's whole duration. A gap
// longer than the pin window resets to a fresh, narrow classification instead
// of accumulating for the entire conversation — bounds schema-token growth.
//
// `sinceLastToolUse` counts turns since the last tool-using turn, reset to 0
// BY that turn itself; the turn immediately after it is therefore the 1st
// follow-up (sinceLastToolUse === 0 going into its check). A strict `<`
// against TOOL_PIN_TURNS means values 0..TOOL_PIN_TURNS-1 stay pinned —
// exactly TOOL_PIN_TURNS follow-up turns, matching the config's own
// description. (`<=` would pin TOOL_PIN_TURNS+1 turns instead, and would
// never let TOOL_PIN_TURNS=0 disable pinning at all.)
//
// Profiles every classifyProfiles() call includes unconditionally — never a
// signal of genuine per-turn intent, so they don't count as "this turn
// introduced something new" below.
const BASELINE_PROFILE_NAMES = new Set(["memory", "self", "data"]);
function hasIntentProfiles(profiles) {
  for (const p of profiles) if (!BASELINE_PROFILE_NAMES.has(p)) return true;
  return false;
}

// Two different texts represent "the current turn" on purpose. `windowedText`
// is today's exact existing classification input (recentUserText's 2-turn
// window, slash-cleaned) — kept unchanged so short ambiguous follow-ups
// ("yes, do it") that lean on the immediately preceding turn's wording keep
// working exactly as before, independent of the pin mechanism. `ownText` is
// this turn's OWN message alone (also slash-cleaned).
//
// `currentTurnProfiles` (returned, budget-priority signal only — never the
// attached tool set) is NOT simply this turn's own classification. A
// keyword-free confirmation ("yes, do it") right after a topic pivot has no
// intent of its own, but the pivot it's confirming is still what's actually
// relevant — degenerating to "nothing" would hand budget priority back to
// whatever was carried FIRST (oldest, e.g. a docgraph turn from before the
// pivot) instead of what's most recently active (the database pivot the
// confirmation is about), on a small llama.cpp window exactly where dropping
// the pivot's own tools (db_query/db_execute) would break the confirmation.
// `pivot` tracks the most recently active intent-bearing classification
// within the pin window — replaced whenever a turn introduces genuine new
// intent, carried forward unchanged across keyword-free pinned turns, and
// cleared on reset alongside `carried`.
//
// The CURRENT turn gets the identical stale-bleed correction (see
// `currentCandidate` below) before falling back to `pivot`/`ownProfiles` —
// not just the historical turns that feed `pivot`. A split-intent turn can
// itself BE the live turn (e.g. "the folder I shared" is the message that
// just triggered `index_folder`, live, this turn) — `ownProfiles` alone would
// suffer the exact same masking bug pivot does, at the turn that matters most
// (the one about to use the tool), not just retroactively on a later
// follow-up.
//
// `pivot` for a turn is its WINDOWED profile set (the same one `carried`
// uses) with one thing removed: whatever is attributable SOLELY to the
// immediately preceding turn's own isolated text and not reinforced by (also
// present in) this turn's own text — see `staleBleedFromPrev`. P2 review
// finding, round 6: an earlier version derived `pivot` from this turn's OWN
// text alone, which handled the "adjacent old topic" case below correctly
// but broke SPLIT intent — "Could you index it?" then "the folder I shared"
// classifies as `indexing` only through the 2-turn window (neither turn's
// own text alone contains both an index word AND a folder word), while
// "the folder I shared" alone happens to ALSO independently match a
// DIFFERENT, weaker profile (`file-project`, from the bare word "folder").
// Own-text-alone pivot picked that weaker profile and lost `indexing`
// entirely, even though `index_folder` was the tool this exact turn called —
// so a keyword-free follow-up wrongly prioritized `file-project` and treated
// `index_folder` as stale, letting a tight llama.cpp schema budget cap away
// the tool just used. Subtracting only "preceding turn's own profile minus
// this turn's own profile" fixes both cases at once: for the adjacent-topic
// case (docgraph then, immediately, database), the OLD topic (docgraph) is
// in the preceding turn's own profile but absent from this turn's own
// profile, so it's correctly stripped as bleed-through; for the split-intent
// case, `indexing` is in NEITHER turn's own-alone profile (it only exists in
// the window), so there is nothing to subtract it against — it survives.
//
// `stickyEnabled` gates ALL of this (the pin/carry loop, `pivot` tracking,
// and priority fallback) to providers that can actually benefit from a
// stable tool array — llama-server's own prefix/KV-cache reuse, which this
// mechanism exists to protect. Every other provider (Anthropic, Gemini,
// DeepSeek, Codex, claude-code) shares this turn-planning code path per
// AGENTS.md's Module Coupling Map, gets no cache benefit from it (their tool
// contracts are left uncapped by capToolsForProvider regardless), and would
// otherwise carry stale/mutating schemas forward for TOOL_PIN_TURNS extra
// turns for no reason — real schema-token cost with no offsetting benefit.
// When disabled, this collapses to exactly the pre-Step-2 behavior: classify
// fresh from the window every turn, no carrying, no pivot.
// Script tool names implied by whichever skills a historical turn's OWN text
// (never the window — skill matching intentionally isn't windowed, see the
// comment in planTurnTools) would have attached live: slash-forced, always-on,
// or keyword-matched (mirrors the identical `s.content?.includes(...)` check
// at the bottom of planTurnTools). P2 review finding: `calledNames` alone
// (toolNamesCalled) only recovers a tool the assistant actually CALLED that
// turn — but a skill can ATTACH run_node_script/run_python_script to the
// request while the assistant calls a different tool that turn (e.g.
// `recall`). The full array llama-server actually cached for that turn still
// included the unused script tool, so a follow-up missing it is exactly as
// cache-invalidating as one missing a called tool. Not reconstructable: a
// caller-supplied forced/semantic-rescue pick (pendingForcedSkillNames/
// pendingSemanticSkillNames are per-call, external inputs never stored in the
// transcript) — a narrow, documented gap; every other origin is exact.
function attachedSkillScriptNames(forcedNames, matchText, skillIndex) {
  const forced = forcedNames.map(n => skillIndex.find(s => s.name === n)).filter(Boolean);
  const alwaysOn = getAlwaysOnSkills(skillIndex);
  const matched = matchSkills(matchText, skillIndex, { limit: 3 });
  const names = new Set();
  for (const s of [...forced, ...alwaysOn, ...matched]) {
    if (s.content?.includes("`node ")) names.add("run_node_script");
    if (s.content?.includes("`python")) names.add("run_python_script");
  }
  return names;
}

// See the long comment above computeStickyProfiles for why this specific
// subtraction (preceding turn's own profile minus THIS turn's own profile) is
// exactly the "stale bleed-through" a 2-turn window can introduce, and no
// more — a profile present in both turns' own text, or in neither (only
// emerging from their combination), is never touched.
function staleBleedFromPrev(prevOwnProfiles, ownProfiles) {
  if (!prevOwnProfiles) return new Set();
  return new Set([...prevOwnProfiles].filter(p => !ownProfiles.has(p)));
}

function computeStickyProfiles(messages, windowedText, ownText, skillIndex, stickyEnabled) {
  const windowedProfiles = classifyProfiles(windowedText);
  const ownProfiles = classifyProfiles(ownText);
  if (!stickyEnabled) return { profiles: windowedProfiles, currentTurnProfiles: ownProfiles, carriedToolNames: new Set(), currentToolNames: new Set() };

  const turns = realUserTurns(messages);
  const historical = turns.slice(0, -1);
  let carried = null;
  // Parallel to `carried`, but tracks the historical turn's actually-ATTACHED
  // tool names (called tools + skill-implied script tools — see
  // attachedSkillScriptNames) rather than classified profile names, since
  // neither classifyProfiles nor "what got called" alone can recover a
  // skill-added tool that was attached but never invoked.
  let carriedToolNames = null;
  let pivot = null;
  // Mirrors `pivot`, but for tool names rather than profiles (P2 review
  // finding): REPLACED (not unioned, unlike `carriedToolNames`) by the most
  // recent turn's own actually-attached/called tool names whenever that set
  // is non-empty, carried forward unchanged across turns with no tool
  // signal of their own while still pinned, cleared on reset alongside
  // `carried`/`pivot`. This is deliberately narrower than the full
  // `carriedToolNames` union: `carriedToolNames` can contain an
  // already-profile-covered tool a much EARLIER turn in the same pin window
  // called (e.g. `doc_search`) — treating the WHOLE accumulated set as
  // budget-priority would reintroduce the exact stale-old-topic-outranks-
  // the-real-pivot bug `pivot` itself was built to prevent (round 2/3), just
  // via tool names instead of profiles. `toolPivot` avoids that by only ever
  // holding the LATEST turn's own tool signal, same as `pivot` does for
  // profiles.
  let toolPivot = null;
  let sinceLastToolUse = Infinity;
  // The immediately preceding historical turn's OWN (single-message)
  // profiles — the one piece of state staleBleedFromPrev needs. `null` for
  // the first historical turn (nothing precedes it) and carried into the
  // final block below so the CURRENT (live) turn gets the identical
  // stale-bleed correction against the LAST historical turn.
  let prevOwnProfiles = null;
  for (let i = 0; i < historical.length; i++) {
    const { idx, raw } = historical[i];
    const nextIdx = historical[i + 1]?.idx ?? turns[turns.length - 1].idx;
    const calledNames = toolNamesCalled(messages, idx + 1, nextIdx);
    const toolUsedAfter = calledNames.size > 0;
    const turnProfiles = classifyProfiles(windowedTextFor(turns, i, skillIndex));
    const slash = parseSlashSkill(raw, skillIndex);
    const ownTurnProfiles = classifyProfiles(slash.cleanedText);
    const skillToolNames = attachedSkillScriptNames(slash.forcedNames, slash.cleanedText, skillIndex);
    const turnToolNames = new Set([...calledNames, ...skillToolNames]);
    const pivotCandidate = new Set([...turnProfiles].filter(p => !staleBleedFromPrev(prevOwnProfiles, ownTurnProfiles).has(p)));
    const pinned = carried && sinceLastToolUse < TOOL_PIN_TURNS;
    carried = pinned ? new Set([...carried, ...turnProfiles]) : turnProfiles;
    carriedToolNames = pinned ? new Set([...carriedToolNames, ...turnToolNames]) : turnToolNames;
    pivot = hasIntentProfiles(pivotCandidate) ? pivotCandidate : (pinned ? pivot : null);
    toolPivot = turnToolNames.size > 0 ? turnToolNames : (pinned ? toolPivot : new Set());
    sinceLastToolUse = toolUsedAfter ? 0 : sinceLastToolUse + 1;
    prevOwnProfiles = ownTurnProfiles;
  }
  const pinned = carried && sinceLastToolUse < TOOL_PIN_TURNS;
  const profiles = pinned ? new Set([...carried, ...windowedProfiles]) : windowedProfiles;
  const currentCandidate = new Set([...windowedProfiles].filter(p => !staleBleedFromPrev(prevOwnProfiles, ownProfiles).has(p)));
  const currentTurnProfiles = hasIntentProfiles(currentCandidate)
    ? currentCandidate
    : (pinned && pivot) ? pivot : ownProfiles;
  return {
    profiles,
    currentTurnProfiles,
    carriedToolNames: pinned ? carriedToolNames : new Set(),
    currentToolNames: (pinned && toolPivot) ? toolPivot : new Set(),
  };
}

// Skill stickiness across a multi-turn workflow (2026-08-13, #250).
//
// Skill matching is deliberately NOT windowed (see the comment in
// planTurnTools): a skill is a heavy, user-visible injection, and folding the
// previous turn's vocabulary into the match text made stale skills attach to
// unrelated follow-ups. That fix is still right, and this does not undo it —
// it addresses the opposite failure, found live on the WS2 T-G2.3 gate.
//
// Curated skill keywords describe how a user OPENS a topic ("how much did I
// spend on utilities"), never how they follow it up ("finish saving them
// now"). `scoreSkill`'s `qualifies` gate requires a literal curated-keyword
// hit, so a workflow skill scores highest of any skill on its own follow-up
// turns and is still dropped: on the provenance ladder,
// `document-intelligence` attached to turn 0 and to no turn after it, while
// `reasoning-planning` (whose keywords are generic process words) attached to
// the turn that mattered and told the model to emit a plan as prose. The model
// then narrated the write it was supposed to perform — four rounds of SKILL.md
// wording were edits to a document that was not in context.
//
// The carry is deliberately narrow, so a stale skill cannot outlive its flow:
//   - At most MAX_CARRIED_SKILLS topics, most-recent-first, oldest evicted.
//     Plain replace-on-new-match was tried first and is wrong: a generic
//     process skill matches trivially mid-flow (`reasoning-planning` scores on
//     the bare word "breakdown"), so it would silently evict the domain
//     workflow that earned the carry — the very failure this exists to fix.
//     Replaying the real provenance ladder showed exactly that, dropping
//     `document-intelligence` at the turn after the interloper. Two is enough
//     for a workflow to survive one interloper and still bounded: a second,
//     genuinely different topic evicts the first.
//   - Gated on the flow still USING TOOLS. `sinceLastToolUse` is the same
//     signal computeStickyProfiles pins on: a workflow mid-flight keeps
//     calling tools, so it keeps its instructions, while ordinary chat after a
//     tool-using turn drops them within the window. This is what keeps the
//     original bug fixed — "hey, how are you?" is not a tool-using flow.
//   - Bounded by SKILL_PIN_TURNS (default 4, `APERIO_SKILL_PIN_TURNS=0`
//     disables), shorter than TOOL_PIN_TURNS because a wrongly-carried skill
//     costs far more prompt tokens than a wrongly-carried tool schema.
// Carried skills are appended AFTER this turn's own matches in planTurnTools,
// so a genuine topic pivot always outranks them.
const MAX_CARRIED_SKILLS = 2;
function computeSkillPin(messages, skillIndex, { currentIsSynthetic = false } = {}) {
  if (!SKILL_PIN_TURNS || !skillIndex?.length) return { carried: [], active: false };
  const turns = realUserTurns(messages);
  // The current turn is the one being planned, so it is never "historical" —
  // unless it is synthetic (a greeting or a preflight-injected message), in
  // which case realUserTurns already excluded it and every real turn behind
  // it, including the most recent one, is history.
  const historical = currentIsSynthetic ? turns : turns.slice(0, -1);
  const endIdx = currentIsSynthetic ? messages.length : (turns[turns.length - 1]?.idx ?? messages.length);
  let carried = [];
  let sinceMatch = Infinity;
  let sinceLastToolUse = Infinity;
  for (let i = 0; i < historical.length; i++) {
    const { idx, raw } = historical[i];
    const nextIdx = historical[i + 1]?.idx ?? endIdx;
    const toolUsedAfter = toolNamesCalled(messages, idx + 1, nextIdx).size > 0;
    // Own text alone, slash-cleaned — mirroring live matching exactly (which
    // matches on the current message only, never the 2-turn window).
    const slash = parseSlashSkill(raw, skillIndex);
    const matched = matchSkills(slash.cleanedText, skillIndex, { limit: 3 });
    if (matched.length) {
      const merged = [];
      for (const s of [...matched, ...carried]) {
        if (!merged.some(m => m.name === s.name)) merged.push(s);
      }
      carried = merged.slice(0, MAX_CARRIED_SKILLS);
      sinceMatch = 0;
    } else {
      sinceMatch += 1;
    }
    sinceLastToolUse = toolUsedAfter ? 0 : sinceLastToolUse + 1;
  }
  const active = sinceMatch < SKILL_PIN_TURNS && sinceLastToolUse < SKILL_PIN_TURNS;
  return { carried: active ? carried : [], active };
}

// Byte-stable skill block for a live flow (2026-08-13 round 7, #250).
//
// The carry above keeps the RIGHT skills attached; this keeps the resolved
// block BYTE-IDENTICAL from turn to turn, which is a different property and
// the one llama.cpp's KV cache is paid in. Skills live in the cached system
// prompt (see model-context-middleware.js's skill-injection stage), so the
// block sits in the prompt prefix: while it does not change, a turn boundary
// is a pure append and reuse is near-total; the moment the matched SET
// changes, the prompt diverges at byte 0 and NOTHING is reused.
//
// Measured on the round-6 verification run: with the set stable, turn 0→1
// went from 33,836 reprocessed tokens / 306 s to 845 / 11.8 s. At the turn
// 1→2 boundary one extra skill matched (sysBytes 46,134 → 52,810) and that
// single turn reprocessed ~45k tokens and burned its whole 600 s ceiling
// without emitting a tool call. Recomputing per turn is therefore worse than
// useless here: a generic process skill (`reasoning-planning` scores on the
// bare word "breakdown") matches trivially mid-flow and costs the entire
// cache.
//
// So: once a flow's block is resolved, it is FROZEN for the pin window —
// this turn's own new matches are ignored while the window is live. Bounds,
// all pre-existing:
//   - llama.cpp only (`providerName`), the one provider whose cache this
//     serves, same scoping as computeStickyProfiles' sticky tool array.
//     Every other provider keeps per-turn matching exactly as before.
//   - Only while computeSkillPin reports the window ACTIVE: the flow is
//     still calling tools and still matching something within
//     SKILL_PIN_TURNS. Ordinary chat after a flow drops the pin on the same
//     signal that already prevents skill bleed.
//   - Forced skills (/skill, wsHandler `forcedSkills`) are prepended fresh
//     every turn and are not themselves pinned; the pin covers the block
//     behind them, so a run that forces the same set on every turn (the
//     harness's `forcedSkills`) is still byte-stable. A forced skill that
//     ALSO matches this turn's text enters the block like any other match.
//   - Dropped whole if any pinned name has left the index (a reloaded
//     skills/ dir re-resolves from scratch rather than replaying a stale
//     name); resolution goes through the CURRENT index, so an edited SKILL.md
//     still takes effect.
// Trade-off, deliberately taken: a genuine topic pivot inside a live
// tool-using llama.cpp flow does not attach its new skill until the window
// closes (≤ SKILL_PIN_TURNS turns) or the user forces it with /skill. The
// alternative is the measured 600 s per-turn abort.
function resolvePinnedSkills(pinnedSkillNames, skillIndex) {
  if (!pinnedSkillNames?.length) return null;
  const resolved = [];
  for (const name of pinnedSkillNames) {
    const skill = skillIndex.find(s => s.name === name);
    if (!skill) return null;
    resolved.push(skill);
  }
  return resolved;
}

function namesForProfiles(profiles) {
  return new Set([...profiles].flatMap((p) => [
    ...(TOOL_PROFILES[p] ?? []),
    ...(HOST_TOOL_PROFILES[p] ?? []),
  ]));
}

/**
 * Plan a turn's uncapped tool names and matched skills from the message text
 * alone. Returns { turnNum, profiles, names, currentTurnNames, skills,
 * notFound, skillPinNames, skillsPinned, hasInlineImage, standaloneVision }.
 * `names` is NOT yet capped to a
 * schema-token budget — the caller applies capToolsForProvider() afterward,
 * since that needs the live provider's contextWindow. `currentTurnNames` is
 * the subset of `names` this specific turn's own text requires (as opposed to
 * carried forward from a pinned multi-turn flow — see computeStickyProfiles);
 * the caller can pass it to capToolsForProvider to prioritize it under budget.
 * `providerName` gates sticky pin/carry accumulation to llama.cpp, the only
 * provider that benefits from a stable tool array (see computeStickyProfiles)
 * — every other provider gets the pre-Step-2 per-turn classification. It also
 * gates the skill-block pin: `pinnedSkillNames` is the previous turn's
 * resolved (non-forced) block for THIS conversation, which the caller stores
 * and feeds back so a live flow keeps sending a byte-identical system prompt;
 * the returned `skillPinNames` is what to store for the next turn, and
 * `skillsPinned` says whether this turn's block came from the pin. See
 * resolvePinnedSkills' comment for the full rationale and bounds.
 * `imageMessages` (defaults to `messages`) is the array `hasInlineImage`/
 * `standaloneVision` are derived from — see the comment at that block for why
 * a caller with both a trimmed and an untrimmed history must pass the
 * trimmed one here even while passing the untrimmed one as `messages`.
 */
export function planTurnTools(messages, userText, {
  turnNum,
  skillIndex,
  shellAllowed,
  pendingForcedSkillNames = [],
  pendingSemanticSkillNames = [],
  pinnedSkillNames = [],
  providerName,
  imageMessages = messages,
} = {}) {
  const lastUser = [...messages].reverse().find(m => m.role === "user");
  const currentIsSynthetic = !!lastUser?.[SYNTHETIC_USER] && extractUserText(lastUser) === userText;

  // Parse /skill prefix from the raw text before matching — this ensures the
  // slash command itself isn't scored as keyword baggage. The cleaned text
  // (without /skill) is what we match and what the LLM sees.
  const rawText = currentIsSynthetic ? "" : recentUserText(messages, userText);
  const slashResult = parseSlashSkill(rawText, skillIndex);
  const text = currentIsSynthetic ? "" : slashResult.cleanedText;

  // Skill matching intentionally does NOT use the multi-turn window above:
  // skills are a visible, heavy context injection (shown to the user as a
  // skill card), so folding in the prior turn's vocabulary caused stale
  // skills to attach to unrelated follow-ups — e.g. a debugging turn's
  // "crash"/"stack trace" language was still in scope on the next, unrelated
  // "hey, how are you?" and wrongly attached debugging-and-error-recovery.
  // /skill forcing is scoped the same way, since parseSlashSkill only
  // matches a "/skill " prefix at the very start of the string — anchored
  // to the current message, not wherever the window happens to start.
  const currentSlash = currentIsSynthetic ? { forcedNames: [], notFound: [], cleanedText: "" } : parseSlashSkill(userText, skillIndex);
  const skillMatchText = currentIsSynthetic ? "" : currentSlash.cleanedText;

  const { profiles, currentTurnProfiles, carriedToolNames, currentToolNames: pinnedToolNames } = currentIsSynthetic
    ? { profiles: classifyProfiles(""), currentTurnProfiles: classifyProfiles(""), carriedToolNames: new Set(), currentToolNames: new Set() }
    : computeStickyProfiles(messages, text, currentSlash.cleanedText, skillIndex, providerName === "llamacpp");
  let names = namesForProfiles(profiles);
  for (const n of carriedToolNames) names.add(n);
  const currentTurnNames = namesForProfiles(currentTurnProfiles);
  // The tool that most recently armed/refreshed the pin must also count as
  // budget-priority, not just availability (P2 review finding):
  // capToolsForWindow treats anything absent from currentTurnNames as stale
  // carryover and orders it AFTER the whole priority bucket. A skill-only
  // tool like run_node_script is never profile-derived, so
  // namesForProfiles(currentTurnProfiles) can never contain it. Deliberately
  // uses `pinnedToolNames` (computeStickyProfiles' toolPivot, the LATEST
  // turn's own tool signal only) here, not the full `carriedToolNames` —
  // carriedToolNames can still hold an already-profile-covered tool a much
  // EARLIER turn in the same pin window called (e.g. `doc_search`), and
  // promoting that to priority would reintroduce the stale-old-topic-
  // outranks-the-real-pivot bug `pivot` itself exists to prevent, just via
  // tool names instead of profiles.
  for (const n of pinnedToolNames) currentTurnNames.add(n);
  if (turnNum <= 1) for (const n of FIRST_TURN_TOOLS) names.add(n);
  if (!shellAllowed) names.delete("run_shell");
  names = filterToolsForIntent(names, text);
  const alwaysOn = getAlwaysOnSkills(skillIndex);
  const matched  = matchSkills(skillMatchText, skillIndex, { limit: 3 });
  const skills = [];
  const seen = new Set();

  // Forced skills (from /skill prefix or from wsHandler) go first.
  const forcedNames = [...new Set([...pendingForcedSkillNames, ...currentSlash.forcedNames])];
  const notFound = [...currentSlash.notFound];
  for (const name of forcedNames) {
    const skill = skillIndex.find(s => s.name === name);
    if (skill && !seen.has(skill.name)) {
      skills.push(skill);
      seen.add(skill.name);
    } else if (!skill && !notFound.includes(name)) {
      notFound.push(name);
    }
  }

  // Semantic-rescue picks (embedding fallback) behave like keyword matches.
  // They are only ever non-empty when matchSkills found nothing this turn
  // (see runAgentLoop), so they fill the blank rather than override anything.
  const semanticMatched = pendingSemanticSkillNames
    .map(n => skillIndex.find(s => s.name === n))
    .filter(Boolean);
  // Carried last, after this turn's own matches, so a genuine topic pivot
  // always outranks a skill still riding a pinned flow (see computeSkillPin).
  const skillPin = computeSkillPin(messages, skillIndex, { currentIsSynthetic });
  // A synthetic turn (the greeting, or a preflight-injected message) has no
  // user text of its own, so it never CARRIES — but it must still send the
  // pinned block, or a mid-flow synthetic turn would drop ~23 KB out of the
  // cached system prompt and diverge the prefix exactly like the churn this
  // pin exists to stop. It also never WRITES the pin (see skillPinNames).
  const carriedSkills = currentIsSynthetic ? [] : skillPin.carried;
  // While the pin window is live, the block this flow already resolved is
  // reused verbatim instead of being recomputed — see resolvePinnedSkills.
  const pinnedBlock = skillPin.active && providerName === "llamacpp"
    ? resolvePinnedSkills(pinnedSkillNames, skillIndex)
    : null;
  const blockSkills = pinnedBlock ?? [...alwaysOn, ...matched, ...semanticMatched, ...carriedSkills];
  for (const s of blockSkills) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    skills.push(s);
  }
  // What the caller stores for the next turn: the block WITHOUT this turn's
  // forced skills, so a one-off /skill never becomes a pinned passenger on
  // the turns after it (and a constant `forcedSkills` set stays stable, since
  // it is prepended fresh every turn either way). `null` on a synthetic turn
  // means "leave the stored pin alone": a synthetic turn resolves no matches,
  // so storing its block would silently demote a live flow's pin to the
  // always-on skills and hand the next real turn a full reprocess.
  const skillPinNames = currentIsSynthetic ? null : [...new Set(blockSkills.map(s => s.name))];
  // These tools are implied by THIS turn's own attached skills (forced,
  // always-on, matched, or semantic-rescue — all genuinely current, never
  // stale carryover), so they belong in currentTurnNames too: without this, a
  // pinned llama.cpp flow's carried-forward intent tools could outrank a
  // skill's required script tool under a tight budget, leaving injected skill
  // instructions with no executable tool to actually follow them.
  for (const s of skills) {
    if (s.content?.includes("`node ")) { names.add("run_node_script"); currentTurnNames.add("run_node_script"); }
    if (s.content?.includes("`python")) { names.add("run_python_script"); currentTurnNames.add("run_python_script"); }
  }

  // `imageMessages` defaults to `messages` for every caller that only has one
  // history array to give (every provider but llama.cpp's own middleware
  // pipeline). llama.cpp's model-context-middleware.js passes `messages` the
  // FULL untrimmed history (so the sticky pin/carry fold above can see
  // historical tool-using turns the context-trimmer already shed — see that
  // file's own `untrimmedMessages` comment) but passes the TRIMMED,
  // model-facing `request.messages` here (P2 review finding): an image
  // upload old enough to have fallen out of the trimmed context is no longer
  // something the model can actually see, so it must not be able to still
  // classify an unrelated later turn ("read this file") as standalone vision
  // and, via filterVisionTools, clear every tool including read_file.
  const hasInlineImage = imageMessages.some(m =>
    m.role === "user" && Array.isArray(m.content) &&
    m.content.some(b => b?.type === "image" && b.source?.data),
  );
  const standaloneVision = hasInlineImage && isStandaloneVisionRequest(userText, { hasImage: true });

  return {
    turnNum, profiles, names, currentTurnNames, skills, notFound,
    skillPinNames, skillsPinned: !!pinnedBlock, hasInlineImage, standaloneVision,
  };
}
