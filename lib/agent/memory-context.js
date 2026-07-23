/**
 * lib/agent/memory-context.js — session/self memory-pointer refresh (issue #307
 * Phase 5a, category 3).
 *
 * Extracted from lib/agent/index.js's refreshSessionMemCtx()/refreshSelfMemCtx().
 * A small stateful factory (owns sessionMemCtx/selfMemCtx as its own closure
 * state) — consistent with the other stateful factories index.js already
 * composes (createToolHooks, createSkillAdmin, createToolCatalog).
 *
 * Dependency direction is bidirectional at the CALL level, not the module
 * level: this module takes `callTool` in (to call recall/self_recall).
 * Separately, index.js's own callTool (which stays in index.js — it is
 * category 4, tool-execution runtime) calls back into this module's
 * refreshSelfMemCtx() after a self-write tool completes. There is no import
 * cycle — index.js is the only place holding both function values and wiring
 * them together — but it is a real crossing worth a reviewer's attention.
 */

// Total memories in the store, read from a 1-row recall: prefer the handler's
// "of N stored memories" footer (the true total), else count the blocks.
export function memCountFromRaw(raw) {
  if (!raw || !raw.trim() || raw.includes("No memories") || raw.trim() === "No result") return 0;
  const m = raw.match(/of (\d+) stored memories/);
  return m ? Number.parseInt(m[1], 10) : raw.split("---").filter(b => b.trim()).length;
}

export function createMemoryContext({ callTool, modelIsCapable, providerIsLocal, logger }) {
  let sessionMemCtx = "";
  let selfMemCtx = "";

  // Memory is only surfaced to capable cloud models, and only as a tiny pointer
  // they can act on via `recall` (query-scoped on demand — never a blind top-N).
  // Local/weak models (Ollama) and toolless models get nothing: they either can't
  // call recall or aren't worth the tokens, so injecting memory just burns context.
  // Called once per session (from buildGreeting) so sessionMemCtx — and therefore
  // the system prompt — stays byte-stable for the rest of the session: the count
  // is intentionally bucketed, not exact, so a remember/forget mid-session can't
  // change this text (prompt-cache hygiene).
  // Returns the count of memories surfaced (0 when memory is off) for the banner.
  async function refreshSessionMemCtx() {
    try {
      const raw = await callTool("recall", { limit: 1 });
      const count = memCountFromRaw(raw);
      const memoryOff = count === 0 || !modelIsCapable();
      sessionMemCtx = memoryOff
        ? ""
        : `MEMORY — you have saved memories about the user and past work, stored outside this ` +
          `conversation. Whenever the user asks what you know or remember, or refers to themselves or an ` +
          `earlier session, call the \`recall\` tool with a query before answering. Never tell the user you ` +
          `have no memory of something without calling recall first.`;
      return memoryOff ? 0 : count;
    } catch (err) {
      logger.warn("[agent] memory preload refresh failed:", err.message);
      return 0;
    }
  }

  // Self-memory preload. Unlike the user-memory preload (a pointer, capable
  // models only), this injects the actual top self-notes so even weak/toolless
  // local models "wake up already remembering" (they can't call self_recall).
  // Local-only: on a cloud provider the self store has zero surface, so this is
  // a no-op and selfMemCtx stays empty.
  async function refreshSelfMemCtx() {
    if (!providerIsLocal()) { selfMemCtx = ""; return 0; }
    try {
      const raw = await callTool("self_recall", { limit: 6 });
      const text = (typeof raw === "string" ? raw : "").trim();
      if (!text || text === "No self-memories yet." || text.startsWith("❌") || text.startsWith("🔒")) {
        selfMemCtx = "";
        return 0;
      }
      selfMemCtx =
        `SELF — continuity notes you have kept for yourself across sessions (your own memory, ` +
        `separate from the user's). They are yours; revise or extend them with the self_* tools as you learn. ` +
        `Do not surface them to the user unless relevant.\n\n${text}`;
      return 1;
    } catch (err) {
      logger.warn("[agent] self-memory preload refresh failed:", err.message);
      selfMemCtx = "";
      return 0;
    }
  }

  return {
    refreshSessionMemCtx,
    refreshSelfMemCtx,
    getSessionMemCtx: () => sessionMemCtx,
    getSelfMemCtx: () => selfMemCtx,
    // Self-memory is local-only: drop the preloaded self-notes immediately when
    // switching to a cloud provider so they never reach a third-party model.
    // Called explicitly by index.js's setProvider (a category-4 action) instead
    // of that function reaching into a bare variable.
    clearSelfMemCtx: () => { selfMemCtx = ""; },
  };
}
