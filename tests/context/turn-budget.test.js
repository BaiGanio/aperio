// T2.13 - the turn budget function (spec S2.13 §2, §3; plan TR14, Appendix A1 items 1, 2, 4).
//
// Pure: no DB, no config read, no server. The tool-loop cases use a fake provider
// that records the exact bytes of every request.
// Ported from v1 at archive/v1-final: tests/unit/context/trim.test.js, all 5 cases,
// cut to the v2 message shape (role 'tool' + tool_call_id, assistant tool_calls).
// v2 differences (spec §2): history is cut by whole turns, so there is no orphan
// pass; the current turn is never dropped, so an uncapped giant result is a
// context_full error instead of v1's "pinned but overflowing".

import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  BudgetError, planBudget, capToolResult, fitHistory, messageTokens, historyTokens,
} from '../../src/context/turn-budget.js';
import { estimateTokens } from '../../src/context/recall-block.js';
import { runToolLoop } from '../../src/tools/tool-loop.js';

const MARKS = { trimAtPct: 85, trimToPct: 60 };
const user = (content) => ({ role: 'user', content });
const call = (id, name = 'recall') => ({
  role: 'assistant', content: '',
  tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }],
});
const result = (id, content) => ({ role: 'tool', tool_call_id: id, content });
const answer = (content) => ({ role: 'assistant', content });

/** Every tool message must follow an assistant message that holds its call id (A1 item 2). */
function assertNoOrphan(history) {
  const open = new Set();
  for (const m of history) {
    if (m.role === 'assistant') for (const c of m.tool_calls ?? []) open.add(c.id);
    if (m.role === 'tool') assert.ok(open.has(m.tool_call_id), `orphan tool result ${m.tool_call_id}`);
  }
}

describe('capToolResult (v1 capToolResults)', () => {
  const usable = planBudget({ nCtx: 32768, prefixTokens: 1400, outputReserve: 2048, toolResultPct: 25, recallBudget: 800 }).usable;
  const max = Math.floor(usable * 0.25);

  test('v1 1: a result over 25 % of the window is cut to head + tail with a mark', () => {
    const body = 'PASS first line\n' + 'noise\n'.repeat(40000) + 'FAIL summary at the very end\n';
    assert.ok(estimateTokens(body) > max, 'fixture must exceed the budget');
    const out = capToolResult(body, max);
    assert.ok(estimateTokens(out) <= max, `capped to budget, got ${estimateTokens(out)}`);
    assert.match(out, /PASS first line/, 'keeps the head');
    assert.match(out, /FAIL summary at the very end/, 'keeps the tail verdict');
    assert.match(out, /truncated to fit context/, 'marks the cut');
  });

  test('v1 2: a small result is the same string; a history below the mark is the same array', () => {
    const small = 'ok, done';
    assert.equal(capToolResult(small, max), small);
    const history = [user('hi'), call('t1'), result('t1', small)];
    const r = fitHistory(history, { usable, ...MARKS });
    assert.equal(r.history, history, 'no change: identity');
    assert.equal(r.trimmed, false);
    assert.equal(r.dropped, 0);
  });

  test('v1 3: a capped result survives the budget on a 32k window (the original bug)', () => {
    const body = 'PASS\n'.repeat(40000) + 'VERDICT: 2 failed\n';
    const raw = [user('run npm run test:ci'), call('t1', 'run_shell'), result('t1', body)];
    // Uncapped: the current turn alone does not fit. v2 says so; it never cuts the user's turn.
    assert.throws(() => fitHistory(raw, { usable, ...MARKS }), (e) => e instanceof BudgetError && e.code === 'context_full');
    // Capped on store (spec §2 item 4): kept, verdict visible.
    const capped = [raw[0], raw[1], result('t1', capToolResult(body, max))];
    const out = fitHistory(capped, { usable, ...MARKS }).history;
    const tool = out.find((m) => m.role === 'tool');
    assert.ok(tool, 'the result is kept');
    assert.match(tool.content, /VERDICT: 2 failed/, 'the verdict reaches the model');
  });
});

describe('fitHistory: whole turns, oldest first', () => {
  test('v1 4: a tool call and its result go together, never an orphan at the head', () => {
    const big = 'x'.repeat(20000); // ~6.7k tokens each
    const history = [
      user('start'), call('a', 'run_shell'), result('a', big), call('b', 'run_shell'), result('b', big), answer('done'),
      user('final question'),
    ];
    const r = fitHistory(history, { usable: 8000, ...MARKS });
    assert.equal(r.trimmed, true);
    assert.equal(r.history[0].role, 'user', 'the kept history starts at a user message');
    assert.deepEqual(r.history, [user('final question')]);
    assert.equal(r.dropped, 6);
    assertNoOrphan(r.history);
  });

  test('v1 5: under pressure the freshest tool pair survives with its call', () => {
    const big = 'x'.repeat(12000); // ~4k tokens
    const history = [
      user('check issue 49'), call('a', 'fetch'), result('a', big), answer('it is long'),
      user('check it again'), call('b', 'fetch'), result('b', 'FRESH ISSUE BODY 49'),
    ];
    const r = fitHistory(history, { usable: 4000, ...MARKS }); // 100 %+ full
    assert.ok(r.history.some((m) => m.role === 'tool' && m.content === 'FRESH ISSUE BODY 49'), 'freshest result kept');
    assert.ok(r.history.some((m) => m.tool_calls?.some((c) => c.id === 'b')), 'its call kept too');
    assertNoOrphan(r.history);
  });

  test('at 100 % full the next call fits; dropped and pct are exact (A1 item 1)', () => {
    const turn = (i) => [user(`q${i} ` + 'w'.repeat(297)), answer(`a${i} ` + 'w'.repeat(297))]; // 100 + 100 tokens
    const history = Array.from({ length: 10 }, (_, i) => turn(i)).flat(); // 2000 tokens
    const usable = 2000;
    assert.equal(historyTokens(history), 2000);
    const r = fitHistory(history, { usable, ...MARKS });
    assert.equal(r.trimmed, true);
    assert.equal(r.pct, 100, 'pct = fill before the trim');
    assert.equal(r.dropped, 8, 'drops 4 whole turns: 2000 → 1200 = 60 %');
    assert.ok(historyTokens(r.history) <= usable * 0.6);
    assert.deepEqual(r.history, history.slice(8));
  });

  test('the current turn is never dropped, even when it alone is over TRIM_TO', () => {
    const history = [user('old'), answer('o'.repeat(150)), user('now ' + 'z'.repeat(2400))]; // 1 + 50 + 802 = 85.3 %
    const r = fitHistory(history, { usable: 1000, ...MARKS });
    assert.deepEqual(r.history, [history[2]]);
  });

  test('a big user message that alone is over usable: context_full, never a silent cut', () => {
    const history = [user('old'), answer('ok'), user('y'.repeat(9000))];
    assert.throws(() => fitHistory(history, { usable: 1000, ...MARKS }), (e) => e instanceof BudgetError && e.code === 'context_full');
  });

  test('just below TRIM_AT: unchanged (hysteresis); at TRIM_AT: trimmed', () => {
    const below = [user('a'.repeat(3 * 42)), answer('b'.repeat(3)), user('c'.repeat(3 * 42))]; // 42 + 1 + 42
    assert.equal(historyTokens(below), 85);
    assert.equal(fitHistory(below, { usable: 101, ...MARKS }).history, below);
    assert.equal(fitHistory(below, { usable: 100, ...MARKS }).trimmed, true);
  });

  test('empty history: nothing to do', () => {
    const r = fitHistory([], { usable: 1000, ...MARKS });
    assert.deepEqual(r, { history: [], dropped: 0, pct: 0, trimmed: false });
  });

  test('messageTokens counts content and tool_calls', () => {
    const m = call('c1', 'remember');
    assert.equal(messageTokens(m), estimateTokens('') + estimateTokens(JSON.stringify(m.tool_calls)));
    assert.equal(messageTokens(result('c1', 'abcdef')), 2);
  });

  test('fuzz: 200 random histories → no orphan, oldest turns first, current turn kept, ≤ TRIM_TO or only the current turn left', () => {
    let seed = 13;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let k = 0; k < 200; k++) {
      const history = [];
      const turns = 1 + rnd(12);
      for (let t = 0; t < turns; t++) {
        history.push(user(`u${k}.${t} ` + 'u'.repeat(rnd(600))));
        for (let c = rnd(3); c > 0; c--) {
          const id = `c${k}.${t}.${c}`;
          history.push(call(id), result(id, 'r'.repeat(rnd(900))));
        }
        if (rnd(2)) history.push(answer('a'.repeat(rnd(400))));
      }
      const lastUser = history.findLastIndex((m) => m.role === 'user');
      const usable = 300 + rnd(2000);
      let r;
      try {
        r = fitHistory(history, { usable, ...MARKS });
      } catch (e) {
        assert.equal(e.code, 'context_full');
        assert.ok(historyTokens(history.slice(lastUser)) > usable, 'context_full only when the current turn alone is too big');
        continue;
      }
      assertNoOrphan(r.history);
      assert.deepEqual(r.history, history.slice(r.dropped), 'only a front slice is removed');
      assert.ok(r.dropped <= lastUser, 'the current turn is kept');
      assert.equal(r.history[0]?.role ?? 'user', 'user');
      if (r.trimmed) assert.ok(historyTokens(r.history) <= usable * 0.6 || r.dropped === lastUser);
      else assert.ok(historyTokens(history) < usable * 0.85 || lastUser === 0, 'no trim only below the mark, or nothing older to drop');
    }
  });
});

describe('planBudget', () => {
  test('usable = nCtx - prefix - reserve; caps from one place', () => {
    const b = planBudget({ nCtx: 8192, prefixTokens: 1392, outputReserve: 2048, toolResultPct: 25, recallBudget: 800 });
    assert.deepEqual(b, { usable: 4752, toolResultMax: 1188, recallMax: 475 });
  });

  test('recallMax is RECALL_TOKEN_BUDGET on a big window (§4 item 4)', () => {
    const b = planBudget({ nCtx: 65536, prefixTokens: 1400, outputReserve: 2048, toolResultPct: 25, recallBudget: 800 });
    assert.equal(b.recallMax, 800);
  });

  test('a window too small for prefix + reserve: window_too_small', () => {
    assert.throws(() => planBudget({ nCtx: 4096, prefixTokens: 2100, outputReserve: 2048, toolResultPct: 25, recallBudget: 800 }),
      (e) => e instanceof BudgetError && e.code === 'window_too_small' && /4096/.test(e.message));
  });
});

/** A fake provider: replies from a script, records every request byte for byte. */
function fakeProvider(script) {
  const sent = [];
  let n = 0;
  return {
    sent,
    async streamChat({ system, messages }) {
      sent.push({ system, bytes: JSON.stringify(messages) });
      const step = script(n++, messages);
      return { text: step.text ?? '', toolCalls: step.toolCalls ?? [], error: null, aborted: false, timings: null };
    },
  };
}
const quiet = () => ({ error: mock.fn(), warn: mock.fn(), info: mock.fn() });
const echoTool = (out) => ({ name: 'recall', run: async () => out });

describe('runToolLoop with a budget (spec §2 items 4, 6-10)', () => {
  const budget = { usable: 2000, toolResultMax: 500, ...MARKS };

  test('a big tool result is cut once, when stored; the stored bytes never change', async () => {
    const provider = fakeProvider((n) => (n === 0 ? { toolCalls: [{ id: 'c1', name: 'recall', args: {} }] } : { text: 'done' }));
    const history = [user('find it')];
    const big = { ok: true, rows: 'HEAD ' + 'r'.repeat(9000) + ' TAIL-VERDICT' };
    await runToolLoop({ provider, system: 'S', history, tools: [echoTool(big)], ctx: {}, emit: () => {}, log: quiet(), budget });
    const tool = history.find((m) => m.role === 'tool');
    assert.ok(estimateTokens(tool.content) <= 500);
    assert.match(tool.content, /TAIL-VERDICT/);
    assert.ok(provider.sent[1].bytes.includes(JSON.stringify(tool.content)), 'the second call sends the capped bytes');
  });

  test('30-turn fake chat: stored history never passes TRIM_AT; bytes extend call to call except at a trim; system byte-identical', async () => {
    const events = [];
    const history = [];
    const provider = fakeProvider((n) => (n % 3 === 0 ? { toolCalls: [{ id: `c${n}`, name: 'recall', args: {} }] } : { text: 'answer ' + 'a'.repeat(300) }));
    const log = quiet();
    for (let t = 0; t < 30; t++) {
      history.push(user(`turn ${t} ` + 'u'.repeat(400)));
      await runToolLoop({ provider, system: 'SYSTEM', history, tools: [echoTool({ ok: true, rows: 'r'.repeat(600) })], ctx: {}, emit: (e) => events.push(e), log, budget });
      assert.ok(historyTokens(history) < budget.usable * 0.85 + 400, `turn ${t}: stored history bounded (${historyTokens(history)})`);
      assertNoOrphan(history);
    }
    const trims = events.filter((e) => e.type === 'context_trimmed');
    assert.ok(trims.length >= 2, `it trimmed (${trims.length})`);
    for (const e of trims) {
      assert.ok(Number.isInteger(e.dropped) && e.dropped > 0);
      assert.ok(Number.isInteger(e.pct) && e.pct >= 85);
    }
    assert.ok(provider.sent.every((s) => s.system === 'SYSTEM'), 'system is byte-identical on every call');
    let extends_ = 0;
    for (let i = 1; i < provider.sent.length; i++) {
      const prev = provider.sent[i - 1].bytes.slice(0, -1);
      if (provider.sent[i].bytes.startsWith(prev)) extends_++;
    }
    assert.equal(extends_, provider.sent.length - 1 - trims.length, 'every call extends the last one, except the calls right after a trim');
    assert.equal(log.info.mock.callCount() >= trims.length, true, 'each trim is logged');
  });

  test('a user turn too big for the window: error context_full, no model call, no silent cut', async () => {
    const provider = fakeProvider(() => ({ text: 'never' }));
    const events = [];
    const history = [user('y'.repeat(9000))];
    const r = await runToolLoop({ provider, system: 'S', history, tools: [], ctx: {}, emit: (e) => events.push(e), log: quiet(), budget });
    assert.equal(provider.sent.length, 0);
    assert.equal(r.error?.kind, 'context_full');
    assert.ok(events.some((e) => e.type === 'error' && e.code === 'context_full'));
    assert.equal(history.length, 1, 'the user turn is kept as it was');
  });

  test('without a budget the loop behaves as before (no trim, no cap)', async () => {
    const provider = fakeProvider(() => ({ text: 'ok' }));
    const history = [user('hi')];
    await runToolLoop({ provider, system: 'S', history, tools: [], ctx: {}, emit: () => {}, log: quiet() });
    assert.deepEqual(history, [user('hi'), answer('ok')]);
  });
});
