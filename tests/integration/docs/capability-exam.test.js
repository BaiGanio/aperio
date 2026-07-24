import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const examDir = path.join(root, "docs", "exam");
const hubPath = path.join(examDir, "capability-exam.html");
const hub = fs.readFileSync(hubPath, "utf8");

const links = [...hub.matchAll(/href="(\.\.\/evaluate\/[^\"]+\.html)"/g)].map((m) => m[1]);
const sectionRows = [...hub.matchAll(/href:"(\.\.\/evaluate\/[^\"]+\.html)"/g)].map((m) => m[1]);

test("capability exam hub has exactly the 14 scored evaluate suites", () => {
  assert.equal(fs.existsSync(hubPath), true);
  assert.equal(fs.readdirSync(examDir).some((name) => /^section-.*\.html$/.test(name)), false);
  assert.equal(new Set(links).size, 14);
  assert.deepEqual([...new Set(links)].sort(), [...new Set(sectionRows)].sort());
  for (const href of new Set(links)) assert.equal(fs.existsSync(path.resolve(examDir, href)), true, href);
  assert.doesNotMatch(sectionRows.join("\n"), /roundtable/i);
});

test("capability exam declares the correct maximum and explicit bonus boundary", () => {
  const maxima = [...hub.matchAll(/max:(\d+), href/g)].map((m) => Number(m[1]));
  assert.deepEqual(maxima, [10, 10, 10, 10, 10, 10, 10, 10, 11, 8, 11, 5, 7, 10]);
  assert.equal(maxima.reduce((sum, max) => sum + max, 0), 132);
  assert.match(hub, /Roundtable[\s\S]*?bonus, unscored/);
  assert.match(hub, /aperio-exam/);
  for (const prerequisite of ["shell", "code graph", "qpdf", "LibreOffice"]) {
    assert.match(hub, new RegExp(prerequisite, "i"), prerequisite);
  }
});

test("scorecard regression contract clamps, persists, resets, and labels results safely", () => {
  assert.match(hub, /raw===''\?0:parseInt\(raw,10\)/);
  assert.match(hub, /input\.value=String\(clamped\)/);
  assert.match(hub, /localStorage\.setItem\('exam-s-'\+s\.n,String\(clamped\)\)/);
  assert.match(hub, /if\(raw===''\)allFilled=false/);
  assert.match(hub, /localStorage\.removeItem\('exam-pct'\)/);
  assert.match(hub, /allFilled\?\(pct>=\.9\?'Excellent':pct>=\.75\?'Strong':pct>=\.5\?'Partial':'Weak'\):'Incomplete'/);
  assert.match(hub, /'Tier: '\+tierLabel/);
  assert.doesNotMatch(hub, /'Tier: '\+pct>=/);
});
