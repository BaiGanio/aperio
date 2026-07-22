import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "../../..");
const DASHBOARDS = resolve(ROOT, "docs/dashboards");
const DASHBOARD_FILES = ["unit.html", "integration.html", "e2e.html"];
const EXPECTED_HEADINGS = ["Total Tests", "Passed", "Failed", "Pass Rate", "Suites", "Duration"];

function source(name) {
  return readFileSync(resolve(DASHBOARDS, name), "utf8");
}

function metricsTemplate(html) {
  return html.match(/document\.querySelector\('#metrics'\)\.innerHTML = `([\s\S]*?)`;\n/)?.[1] || "";
}

function metricChunks(template) {
  const starts = [...template.matchAll(/<h2>([^<]+)<\/h2>/g)];
  return starts.map((match, index) => ({
    heading: match[1].replace(/\b\w/g, (letter) => letter.toUpperCase()),
    html: template.slice(match.index, starts[index + 1]?.index ?? template.length),
  }));
}

test("unit, integration, and E2E dashboards share the approved six-card summary", () => {
  for (const name of DASHBOARD_FILES) {
    const cards = metricChunks(metricsTemplate(source(name)));
    assert.deepEqual(cards.map(({ heading }) => heading), EXPECTED_HEADINGS, name);

    const byHeading = Object.fromEntries(cards.map((card) => [card.heading, card.html]));
    assert.doesNotMatch(byHeading["Total Tests"], /<small\b|class="meter"/, `${name}: total tests detail`);
    assert.match(byHeading.Passed, /class="meter"/, `${name}: passed meter`);
    assert.match(byHeading.Failed, /skipped/, `${name}: failed skipped count`);
    assert.doesNotMatch(byHeading["Pass Rate"], /<small\b|class="meter"/, `${name}: pass-rate detail`);
    assert.doesNotMatch(byHeading.Suites, /<small\b|class="meter"/, `${name}: suites detail`);
    assert.match(byHeading.Duration, /<small>total wall-clock<\/small>/, `${name}: duration label`);
    assert.doesNotMatch(byHeading.Duration, /class="meter"/, `${name}: duration meter`);
  }
});

test("six-card dashboard summaries use available group or suite counts", () => {
  for (const name of ["unit.html", "integration.html"]) {
    assert.match(metricsTemplate(source(name)), /<h2>Suites<\/h2>[\s\S]*?data\.groups\.length/, name);
  }
  assert.match(metricsTemplate(source("e2e.html")), /<h2>Suites<\/h2>[\s\S]*?data\.suites\.length/);
});

test("E2E run metadata follows the unit and integration format", () => {
  const html = source("e2e.html");
  const run = html.match(/\/\/ Run info\n([\s\S]*?)\n\n\/\/ Metrics/)?.[1] || "";
  assert.match(run, /<strong>e2e run<\/strong>/);
  assert.match(run, /data\.branch/);
  assert.match(run, /data\.commit/);
  assert.doesNotMatch(run, /data\.total|data\.suites/);
});

test("six-card summaries remain responsive", () => {
  const css = source("styles.css");
  assert.match(css, /body\.e2e-dashboard \.metrics\{grid-template-columns:repeat\(6,minmax\(0,1fr\)\)\}/);
  assert.match(css, /body\.result-dashboard \.metrics\{grid-template-columns:repeat\(6,minmax\(0,1fr\)\)\}/);
  assert.match(css, /@media\(max-width:1180px\)[\s\S]*?\.metrics\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)\}/);
  assert.match(css, /@media\(max-width:560px\)[\s\S]*?\.metrics\{grid-template-columns:1fr\}/);
});
