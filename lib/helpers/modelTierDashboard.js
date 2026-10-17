import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const OUTPUT_NAME = "dashboard-data.js";

export function parseMetricsCsv(text) {
  const lines = String(text ?? "").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",");
  return lines.slice(1).map(line => Object.fromEntries(
    line.split(",").map((value, index) => [headers[index], index < 2 ? value : Number(value)]),
  ));
}

function safeAttempt(attempt) {
  if (!attempt || typeof attempt !== "object") return null;
  return {
    status: attempt.status ?? null,
    actualToolSequence: Array.isArray(attempt.actualToolSequence) ? attempt.actualToolSequence : [],
    statePassed: attempt.statePassed ?? null,
    completed: attempt.completed ?? null,
    timeoutKind: attempt.timeoutKind ?? null,
  };
}

export function sanitizeCase(item = {}) {
  return {
    id: item.id ?? null,
    section: item.section ?? null,
    kind: item.kind ?? null,
    hardGate: item.hardGate === true,
    status: item.status ?? null,
    durationMs: Number.isFinite(Number(item.durationMs)) ? Number(item.durationMs) : null,
    actualToolSequence: Array.isArray(item.actualToolSequence) ? item.actualToolSequence : [],
    toolSequencePassed: item.toolSequencePassed ?? null,
    toolsSuccessful: item.toolsSuccessful ?? null,
    statePassed: item.statePassed ?? null,
    completed: item.completed ?? null,
    timeoutKind: item.timeoutKind ?? null,
    guardrailMode: item.guardrailMode ?? null,
    retried: item.retried === true,
    firstAttempt: safeAttempt(item.firstAttempt),
    retry: safeAttempt(item.retry),
  };
}

export function buildDashboardData({ run = {}, cases = [], metrics = [] } = {}) {
  const model = run.model && typeof run.model === "object" ? run.model : {};
  return {
    schemaVersion: 1,
    privateDataExcluded: true,
    run: {
      status: run.status ?? null,
      campaignId: run.campaignId ?? null,
      targetTierGB: run.targetTierGB ?? null,
      model: {
        id: model.id ?? null,
        displayName: model.displayName ?? null,
      },
      profile: run.profile ?? null,
      servedContext: run.servedContext ?? null,
      hardware: run.hardware ?? null,
      ramGB: run.ramGB ?? null,
      startedAt: run.startedAt ?? null,
      finishedAt: run.finishedAt ?? null,
      qualificationSuiteVersion: run.qualificationSuiteVersion ?? null,
      invalid: run.status === "invalid",
    },
    cases: cases.map(sanitizeCase),
    metrics: metrics.map(sample => ({
      phase: sample.phase ?? null,
      at: sample.at ?? null,
      usedRamBytes: Number(sample.usedRamBytes) || 0,
      aperioRssBytes: Number(sample.aperioRssBytes) || 0,
      llamaRssBytes: Number(sample.llamaRssBytes) || 0,
      swapBytes: Number(sample.swapBytes) || 0,
    })),
  };
}

export function writeDashboardData(artifactDir, { outputName = OUTPUT_NAME, outputPath: requestedOutputPath } = {}) {
  const run = JSON.parse(readFileSync(join(artifactDir, "run.json"), "utf8"));
  const cases = readFileSync(join(artifactDir, "cases.jsonl"), "utf8")
    .split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const metrics = parseMetricsCsv(readFileSync(join(artifactDir, "metrics.csv"), "utf8"));
  const outputPath = requestedOutputPath ?? join(artifactDir, outputName);
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  const tempPath = `${outputPath}.tmp`;
  writeFileSync(tempPath, `window.APERIO_BENCHMARK = ${JSON.stringify(buildDashboardData({ run, cases, metrics }))};\n`, { mode: 0o600 });
  renameSync(tempPath, outputPath);
  return outputPath;
}

export { OUTPUT_NAME };
