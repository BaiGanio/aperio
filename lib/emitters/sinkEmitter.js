// lib/emitters/sinkEmitter.js
//
// Headless emitter for background-agent freeform runs (see docs/background-agents.md).
//
// runAgentLoop streams progress through an emitter's .send() and *returns* the
// final answer string, so a background job doesn't need to decode the event
// stream to get the answer — it just needs a sink that satisfies the .send()
// contract. We still collect the tool names that scrolled by so the run record
// can show what the agent actually did.

/**
 * @returns {{ emitter: { send: (obj: object) => void }, events: object[], toolsUsed: string[] }}
 */
export function makeSinkEmitter() {
  const events = [];
  const toolsUsed = [];
  const offloadStats = { count: 0, bytes: 0 };
  return {
    events,
    toolsUsed,
    offloadStats,
    emitter: {
      send(obj) {
        events.push(obj);
        if (obj?.type === "tool" && obj.name) toolsUsed.push(obj.name);
        if (obj?.type === "tool_result_offloaded") {
          offloadStats.count++;
          offloadStats.bytes += Number(obj.byteCount) || 0;
        }
      },
    },
  };
}
