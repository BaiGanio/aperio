import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "../../..");
const DOCS = join(ROOT, "docs");
const TOPICS = join(ROOT, "manual/topics");
const TOPIC_FILES = {
  "getting-started": "aperio-getting-started-a4.pdf",
  "everyday-memory": "aperio-everyday-memory-a4.pdf",
  "files-tools": "aperio-files-tools-a4.pdf",
  connecting: "aperio-connecting-a4.pdf",
  "setup-configuration": "aperio-setup-configuration-a4.pdf",
  "privacy-upkeep": "aperio-privacy-upkeep-a4.pdf",
};

test("landing page links to the English A4 manual index", () => {
  const landing = readFileSync(join(DOCS, "index.html"), "utf8");
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  assert.match(landing, /<a href="manual\.html">Manual<\/a>/);
  assert.match(readme, /https:\/\/baiganio\.github\.io\/aperio\/manual\.html/);
});

test("manual index publishes exactly the six approved A4 downloads", () => {
  const manual = readFileSync(join(DOCS, "manual.html"), "utf8");
  const downloads = [...manual.matchAll(/<a\b[^>]*class="download"[^>]*href="([^"]+)"[^>]*download/g)]
    .map((match) => match[1]);

  assert.deepEqual(downloads, Object.values(TOPIC_FILES).map((name) => `manual/${name}`));
  assert.doesNotMatch(manual, /letter/i);

  for (const href of downloads) {
    const pdf = join(DOCS, href);
    assert.ok(existsSync(pdf), `${href} must be present in the Pages source`);
    assert.equal(readFileSync(pdf, { encoding: "utf8", flag: "r" }).slice(0, 5), "%PDF-", href);
    assert.ok(statSync(pdf).size > 100_000, `${href} must be a non-trivial PDF`);
  }
});

test("topic builds and aggregate publisher generate A4 only", () => {
  const publisher = readFileSync(join(ROOT, "manual/build-all.sh"), "utf8");
  assert.doesNotMatch(publisher, /letter/i);

  for (const [topic, filename] of Object.entries(TOPIC_FILES)) {
    const build = readFileSync(join(TOPICS, topic, "build.sh"), "utf8");
    assert.match(build, new RegExp(filename.replaceAll(".", "\\.")));
    assert.doesNotMatch(build, /page-letter|-letter\.pdf/i, topic);
    assert.match(publisher, new RegExp(`${topic}:${filename}`));
  }
});
