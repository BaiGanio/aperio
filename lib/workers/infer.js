// lib/workers/infer.js
// Background inference loop: reads recent memories, asks the configured LLM
// for patterns that aren't already explicitly stated, and stores them as
// 'inference' type memories with confidence 0.6 and source 'derived'.

import { complete } from '../helpers/completion.js';
import logger       from '../helpers/logger.js';

const INFER_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const INITIAL_DELAY_MS  = 90_000;          // 90 s after boot

const PROMPT = (memories) =>
`You are analyzing a user's stored memories to discover implicit patterns.

Given the memories below, identify behavioral tendencies, preferences, or recurring themes that are NOT already explicitly stated as a fact or preference. Only return insights that are genuinely novel — if nothing new can be inferred, return an empty JSON array.

Return ONLY a JSON array (no explanation, no markdown) with objects shaped like:
{ "title": "short title", "content": "one-sentence insight" }

Maximum 3 items. Be conservative — only include high-confidence inferences.

Memories:
${memories}`;

/**
 * Starts a background inference loop.
 *
 * @param {Function} callTool - agent.callTool (same as the dedup worker)
 */
export function inferMemories(callTool) {
  async function runInference() {
    try {
      // Fetch a broad set of current memories (excluding prior inferences)
      const raw = await callTool('recall', { limit: 25, search_mode: 'fulltext' });
      if (!raw || raw === 'No memories found.' || raw === 'No result') return;

      // Strip existing inference blocks to avoid circular reasoning
      const blocks = raw.split('---').filter(b => !b.trim().startsWith('[INFERENCE]'));
      if (blocks.length < 3) return;

      const memories = blocks.slice(0, 20).join('\n---\n');
      const response = await complete([{ role: 'user', content: PROMPT(memories) }]);

      // Extract JSON array from response (model may wrap it in markdown)
      const match = response.match(/\[[\s\S]*\]/);
      if (!match) return;

      const inferences = JSON.parse(match[0]);
      if (!Array.isArray(inferences) || !inferences.length) return;

      let stored = 0;
      for (const inf of inferences) {
        if (!inf?.title || !inf?.content) continue;
        await callTool('remember', {
          type:       'inference',
          title:      inf.title,
          content:    inf.content,
          tags:       ['derived'],
          importance: 2,
          confidence: 0.6,
          source:     'derived',
        });
        stored++;
      }

      if (stored > 0) logger.info(`🧠 Inferred ${stored} new pattern(s)`);
    } catch (err) {
      // Inference failures are non-fatal — log at debug level only
      logger.debug(`[infer] skipped: ${err.message}`);
    }
  }

  let intervalId = null;
  const initialId = setTimeout(() => {
    runInference();
    intervalId = setInterval(runInference, INFER_INTERVAL_MS);
  }, INITIAL_DELAY_MS);

  return {
    stop() {
      clearTimeout(initialId);
      if (intervalId) clearInterval(intervalId);
    },
  };
}
