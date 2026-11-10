// tests/eval/fake-adapter.js — an in-memory TargetAdapter for the runner and
// contract tests. No model, no server, no disk. Each knob is explicit so a
// test states exactly what the "model" does.

/**
 * @param {object} [opts]
 * @param {(text: string, ctx: {sessionIndex: number, store: object[]}) => string} [opts.answer]
 * @param {(text: string) => object[]} [opts.toolEvents]  tool_start/tool_result events for a turn
 * @param {(query: string, mode: string, store: object[]) => string[]} [opts.titles]
 * @param {number} [opts.emptyCompletions]  how many empty answers to give before a real one, per turn
 */
export function makeFakeAdapter(opts = {}) {
  const calls = { start: 0, stop: 0, seed: 0, reset: 0, turns: [], recalls: [] };
  const answer = opts.answer ?? ((text) => `echo: ${text}`);
  const toolEvents = opts.toolEvents ?? (() => []);
  const titles = opts.titles ?? ((query, _mode, store) =>
    store.filter((m) => query.toLowerCase().includes(m.title.split(' ')[0].toLowerCase())).map((m) => m.title));
  /** Calls seen per turn text, so the first N attempts of a turn come back empty. */
  const attempts = new Map();

  return {
    name: 'fake',
    calls,
    async start() {
      calls.start++;
      const store = [];
      let sessionIndex = 0;
      return {
        async seedMemories(rows) {
          calls.seed++;
          store.push(...rows);
        },
        async recall(query, k, { mode = 'auto' } = {}) {
          calls.recalls.push({ query, k, mode });
          return { titles: titles(query, mode, store).slice(0, k) };
        },
        async turn(text) {
          calls.turns.push({ text, sessionIndex });
          const seen = (attempts.get(text) ?? 0) + 1;
          attempts.set(text, seen);
          if (seen <= (opts.emptyCompletions ?? 0)) {
            const events = [{ type: 'stream_start' }, { type: 'stream_end', text: '' }, { type: 'turn_complete', status: 'completed' }];
            return { events, text: '' };
          }
          const reply = answer(text, { sessionIndex, store });
          const events = [
            { type: 'stream_start' },
            ...toolEvents(text),
            { type: 'stream_end', text: reply },
            { type: 'turn_complete', status: 'completed' },
          ];
          return { events, text: reply };
        },
        async reset() {
          calls.reset++;
          sessionIndex++;
        },
      };
    },
    async stop() {
      calls.stop++;
    },
  };
}
