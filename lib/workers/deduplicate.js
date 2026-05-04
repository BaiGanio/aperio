const DEDUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const INITIAL_DELAY_MS  = 30_000;         // wait 30s after boot before first run

/**
 * Starts a background deduplication loop.
 * Waits INITIAL_DELAY_MS after boot, then runs every DEDUP_INTERVAL_MS.
 *
 * @param {Function} callTool - agent.callTool
 */
export function deduplicateMemories(callTool) {
  async function runDeduplication() {
    try {
      const r = await callTool("deduplicate_memories", { threshold: 0.97, dry_run: true });
      if (r.split("\n").filter(l => l.trim()).length > 1) console.log(`🧹 Deduplication of memories:\n${r}`);
    } catch {}
  }

  let intervalId = null;
  const initialId = setTimeout(() => {
    runDeduplication();
    intervalId = setInterval(runDeduplication, DEDUP_INTERVAL_MS);
  }, INITIAL_DELAY_MS);

  return {
    stop() {
      clearTimeout(initialId);
      if (intervalId) clearInterval(intervalId);
    },
  };
}