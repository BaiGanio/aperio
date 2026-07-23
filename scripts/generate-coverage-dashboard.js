#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const input = option("--input", "coverage/lcov.info");
  const output = option("--output", "docs/benchmarks/code-cov/coverage-data.js");

const text = await readFile(input, "utf8");
const files = text.split("end_of_record").map(parseRecord).filter(Boolean);

if (!files.length) throw new Error(`No LCOV records found in ${input}`);

const total = files.reduce((sum, file) => addCounts(sum, file), emptyCounts());
const groups = new Map();
for (const file of files) {
  const group = groupFor(file.path);
  if (!groups.has(group)) groups.set(group, emptyCounts());
  addCounts(groups.get(group), file);
}

const data = {
  generatedAt: new Date().toISOString(),
  source: "coverage/lcov.info",
  files: files.map((file) => ({
    ...file,
    group: groupFor(file.path),
    percent: coverage(file),
    branchesPercent: percent(file.branchesHit, file.branchesFound),
    functionsPercent: percent(file.functionsHit, file.functionsFound),
    uncoveredLines: file.linesFound - file.linesHit,
  })).sort((a, b) => a.percent - b.percent || b.uncoveredLines - a.uncoveredLines || a.path.localeCompare(b.path)),
  groups: [...groups.entries()].map(([name, counts]) => ({
    name,
    ...counts,
    percent: percent(counts.linesHit, counts.linesFound),
    branchesPercent: percent(counts.branchesHit, counts.branchesFound),
    functionsPercent: percent(counts.functionsHit, counts.functionsFound),
    uncoveredLines: counts.linesFound - counts.linesHit,
  })),
  totals: {
    ...total,
    percent: percent(total.linesHit, total.linesFound),
    branchesPercent: percent(total.branchesHit, total.branchesFound),
    functionsPercent: percent(total.functionsHit, total.functionsFound),
  },
};

await writeFile(output, `window.APERIO_COVERAGE = ${JSON.stringify(data)};\n`, "utf8");
console.log(`Generated ${output} from ${files.length} LCOV files`);

function parseRecord(record) {
  const source = record.match(/^SF:(.+)$/m)?.[1];
  if (!source) return null;
  const lines = [...record.matchAll(/^DA:\d+,(\d+)/gm)].map((match) => Number(match[1]));
  const branches = [...record.matchAll(/^BRDA:[^,]*,[^,]*,[^,]*,([^\n]+)/gm)].map((match) => match[1].trim() === "-" ? 0 : Number(match[1]));
  const functions = [...record.matchAll(/^FNDA:(\d+),/gm)].map((match) => Number(match[1]));
  return {
    path: source.replace(/^.*?\/(lib|mcp|db)\//, "$1/"),
    linesFound: lines.length,
    linesHit: lines.filter(Boolean).length,
    branchesFound: branches.length,
    branchesHit: branches.filter(Boolean).length,
    functionsFound: functions.length,
    functionsHit: functions.filter(Boolean).length,
  };
}

function emptyCounts() {
  return { linesFound: 0, linesHit: 0, branchesFound: 0, branchesHit: 0, functionsFound: 0, functionsHit: 0 };
}

function addCounts(target, source) {
  target.linesFound += source.linesFound;
  target.linesHit += source.linesHit;
  target.branchesFound += source.branchesFound;
  target.branchesHit += source.branchesHit;
  target.functionsFound += source.functionsFound;
  target.functionsHit += source.functionsHit;
  return target;
}

function coverage(file) {
  return percent(file.linesHit, file.linesFound);
}

function groupFor(filePath) {
  return filePath.startsWith("lib/") ? "lib/"
    : filePath.startsWith("mcp/") ? "mcp/"
      : filePath.startsWith("db/") ? "db/"
        : "entrypoints";
}

function percent(hit, found) {
  return found ? Number(((hit / found) * 100).toFixed(1)) : 100;
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}
