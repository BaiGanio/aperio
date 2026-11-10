// src/eval/fixtures.js — load and resolve the eval fixtures in evals/
// (spec S2.1 "Fixtures"). Dates in memories.json are relative (`daysAgo`)
// and resolve to absolute ISO dates from the one fixed `asOf`, never from the
// clock, so every run seeds the same store.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const DAY_MS = 86_400_000;

/**
 * @param {string} dir  the evals/ directory
 * @returns {Promise<{memories: object, corpus: object, scenarios: object[]}>}
 */
export async function loadEvalFixtures(dir) {
  const readJson = async (file) => {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      throw new Error(`eval fixture ${file}: ${err.message}`, { cause: err });
    }
  };
  const memories = await readJson(join(dir, 'memories.json'));
  const corpus = await readJson(join(dir, 'corpus.json'));
  const scenarioDir = join(dir, 'scenarios');
  const names = (await readdir(scenarioDir)).filter((n) => n.endsWith('.json')).sort();
  const scenarios = [];
  for (const name of names) {
    const scenario = await readJson(join(scenarioDir, name));
    if (`${scenario.id}.json` !== name) throw new Error(`eval fixture ${name}: id "${scenario.id}" does not match the file name`);
    scenarios.push(scenario);
  }
  return { memories, corpus, scenarios };
}

/**
 * @param {{asOf: string, memories: object[]}} fixture
 * @returns {object[]} every row with an absolute `createdAt`; `daysAgo` is dropped
 */
export function resolveMemoryDates(fixture) {
  const asOf = Date.parse(fixture.asOf);
  if (!Number.isFinite(asOf)) throw new Error(`memories.json: asOf is not an absolute date: ${fixture.asOf}`);
  return fixture.memories.map((row) => {
    if (!Number.isInteger(row.daysAgo) || row.daysAgo < 0) {
      throw new Error(`memories.json: row "${row.title}" needs an integer daysAgo >= 0`);
    }
    const { daysAgo, ...rest } = row;
    return { ...rest, createdAt: new Date(asOf - daysAgo * DAY_MS).toISOString() };
  });
}

/** The rows a store is seeded with: every row not marked `seed: false`. */
export function seedRows(fixture) {
  return resolveMemoryDates(fixture)
    .filter((row) => row.seed !== false)
    .map(({ seed: _seed, setBy: _setBy, ...row }) => row);
}

/**
 * The worked trim arithmetic for a trim / tail-slice scenario (settles #358).
 * Every padded turn costs `padTokensPerTurn` (the filler size under the v2
 * token counter, asserted when the mock adapter lands). Trimming drops the
 * oldest padded turns until the history fits the window.
 *
 * @param {{budget: {contextWindowTokens: number, padTokensPerTurn: number}, sessions: object[]}} scenario
 */
export function trimArithmetic(scenario) {
  const { contextWindowTokens, padTokensPerTurn } = scenario.budget;
  const turns = scenario.sessions.flatMap((s) => s.turns).length;
  const totalTokens = turns * padTokensPerTurn;
  const over = totalTokens - contextWindowTokens;
  const dropped = over > 0 ? Math.ceil(over / padTokensPerTurn) : 0;
  // Distance to the nearest branch boundary: "no trim at all" on one side,
  // "drop one more turn" on the other. Far from both = not flaky.
  const marginTokens = over > 0 ? Math.min(over, dropped * padTokensPerTurn - over) : contextWindowTokens - totalTokens;
  return { turns, totalTokens, windowTokens: contextWindowTokens, dropped, marginTokens };
}
