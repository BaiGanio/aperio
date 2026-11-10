// tests/eval/eval-report.test.js — T2.1 run settings and the report shape
// (spec S2.1 §2 "Runs", "Limits", §3): N = 5 by default from config, N = 1
// only when forced, mean and spread always, train and holdout always apart.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEvalSettings } from '../../src/eval/settings.js';
import { buildReport, validateReport } from '../../src/eval/report.js';

const s = (mean) => ({ n: 5, mean, stdev: 0.01, min: mean, max: mean });
const latency = { n: 10, meanMs: 900, stdevMs: 80, p95Ms: 1100, maxMs: 1400, maxEventLoopLagMs: 12 };

function splitBlock() {
  return {
    hitRateAt5: { semantic: s(0.8), fulltext: s(0.7), auto: s(0.85) },
    usedWithoutHint: s(0.6),
    toolSuccess: s(0.9),
    latency,
    emptyRetry: 0,
  };
}

function meta() {
  return { target: 'v1-live', commit: 'de826ea2', date: '2026-11-10T12:00:00.000Z', runs: 5, seed: 42, temperature: 0, k: 5 };
}

describe('eval settings', () => {
  test('N = 5 by default', () => {
    assert.equal(resolveEvalSettings().runs, 5);
  });

  test('every tunable is a setting, not a module constant', () => {
    const settings = resolveEvalSettings();
    for (const key of ['runs', 'k', 'seed', 'temperature', 'maxEmptyRetries', 'turnTimeoutMs', 'startTimeoutMs', 'maxEventsPerTurn', 'modes', 'defaultPorts', 'tmpBase']) {
      assert.ok(key in settings, `settings carry ${key}`);
    }
  });

  test('an override wins over the default', () => {
    assert.equal(resolveEvalSettings({ runs: 7 }).runs, 7);
  });

  test('two calls never share state', () => {
    const a = resolveEvalSettings();
    const b = resolveEvalSettings({ runs: 9 });
    assert.equal(a.runs, 5);
    assert.equal(b.runs, 9);
  });

  test('N = 1 is rejected unless explicitly forced', () => {
    assert.throws(() => resolveEvalSettings({ runs: 1 }), /N = 1/);
    assert.equal(resolveEvalSettings({ runs: 1, forceSingleRun: true }).runs, 1);
  });

  test('N below 1 or not an integer is rejected', () => {
    assert.throws(() => resolveEvalSettings({ runs: 0 }), /runs/);
    assert.throws(() => resolveEvalSettings({ runs: 2.5 }), /runs/);
  });

  test('an unknown key is rejected by name', () => {
    assert.throws(() => resolveEvalSettings({ rnus: 5 }), /rnus/);
  });
});

describe('eval report', () => {
  test('a full report validates: 4 metrics, per model, per split, with N, seed, model ids, commit and date', () => {
    const report = buildReport(meta(), [
      { id: 'gemma-4-E4B-it-qat', splits: { train: splitBlock(), holdout: splitBlock() } },
      { id: 'Ornith-1.0-9B-MTP', splits: { train: splitBlock(), holdout: splitBlock() } },
    ]);
    assert.doesNotThrow(() => validateReport(report));
    assert.equal(report.runs, 5);
    assert.deepEqual(report.models.map((m) => m.id), ['gemma-4-E4B-it-qat', 'Ornith-1.0-9B-MTP']);
  });

  test('train and holdout are separate numbers', () => {
    const train = splitBlock();
    const holdout = { ...splitBlock(), usedWithoutHint: s(0.2) };
    const report = buildReport(meta(), [{ id: 'm', splits: { train, holdout } }]);
    assert.equal(report.models[0].splits.train.usedWithoutHint.mean, 0.6);
    assert.equal(report.models[0].splits.holdout.usedWithoutHint.mean, 0.2);
  });

  for (const missing of ['train', 'holdout']) {
    test(`a run that scores no ${missing} split fails`, () => {
      const splits = { train: splitBlock(), holdout: splitBlock() };
      delete splits[missing];
      assert.throws(() => buildReport(meta(), [{ id: 'm', splits }]), new RegExp(missing));
    });
  }

  for (const metric of ['hitRateAt5', 'usedWithoutHint', 'toolSuccess', 'latency']) {
    test(`a split without ${metric} fails with the metric name`, () => {
      const train = splitBlock();
      delete train[metric];
      assert.throws(() => buildReport(meta(), [{ id: 'm', splits: { train, holdout: splitBlock() } }]), new RegExp(metric));
    });
  }

  test('a score with no spread fails: a single number is never a result', () => {
    const train = { ...splitBlock(), toolSuccess: { n: 5, mean: 0.9 } };
    assert.throws(() => buildReport(meta(), [{ id: 'm', splits: { train, holdout: splitBlock() } }]), /stdev/);
  });

  test('a latency block without max or event-loop lag fails', () => {
    const noMax = { ...latency };
    delete noMax.maxMs;
    const train = { ...splitBlock(), latency: noMax };
    assert.throws(() => buildReport(meta(), [{ id: 'm', splits: { train, holdout: splitBlock() } }]), /maxMs/);
  });

  for (const field of ['commit', 'date', 'runs', 'seed']) {
    test(`a report without ${field} fails`, () => {
      const m = meta();
      delete m[field];
      assert.throws(() => buildReport(m, [{ id: 'm', splits: { train: splitBlock(), holdout: splitBlock() } }]), new RegExp(field));
    });
  }
});
