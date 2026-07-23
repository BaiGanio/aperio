import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

const ROOT = resolve(import.meta.dirname, "../../..");
const DOCS = join(ROOT, "docs");

function htmlFiles(directory = DOCS) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return htmlFiles(path);
    return entry.name.endsWith(".html") ? [path] : [];
  });
}

function navbarLinks(path) {
  const html = readFileSync(path, "utf8");
  const nav = html.match(/<nav\b[^>]*class=["'][^"']*aperio-nav[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i)?.[1] || "";
  const list = nav.match(/<ul\b[^>]*class=["'][^"']*nav-links[^"']*["'][^>]*>([\s\S]*?)<\/ul>/i)?.[1] || "";
  return [...list.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)].map((match) => match[1]);
}

function normalizedNavbarLinks(path) {
  return navbarLinks(path).map((href) => relative(DOCS, resolve(dirname(path), href)));
}

function footerLinks(path) {
  const html = readFileSync(path, "utf8");
  const footer = html.match(/<footer\b[^>]*>([\s\S]*?)<\/footer>/i)?.[1]
    || html.match(/<div\b[^>]*class=["'][^"']*footer[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]
    || "";
  return [...footer.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)].map((match) => match[1]);
}

test("docs HTML contains no missing local files or fragments", () => {
  const broken = [];
  for (const source of htmlFiles()) {
    const html = readFileSync(source, "utf8");
    const hrefs = [...html.matchAll(/href=["']([^"']+)["']/gi)].map((match) => match[1]);
    for (const href of hrefs) {
      if (/^(?:https?:|mailto:)/.test(href)) continue;
      const hashAt = href.indexOf("#");
      const relativePath = hashAt >= 0 ? href.slice(0, hashAt) : href;
      const fragment = hashAt >= 0 ? href.slice(hashAt + 1) : "";
      const target = relativePath ? resolve(dirname(source), relativePath) : source;
      if (!readFileExists(target)) {
        broken.push(`${relative(ROOT, source)} -> ${href} (missing file)`);
        continue;
      }
      if (!fragment) continue;
      const targetHtml = readFileSync(target, "utf8");
      if (!targetHtml.includes(`id="${fragment}"`) && !targetHtml.includes(`id='${fragment}'`)) {
        broken.push(`${relative(ROOT, source)} -> ${href} (missing fragment)`);
      }
    }
  }
  assert.deepEqual(broken, []);
});

function readFileExists(path) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

test("dashboard navbars expose one canonical link set", () => {
  const expected = [
    "index.html",
    "tools/benchmarking.html",
    "dashboards/coverage.html",
    "dashboards/unit.html",
    "dashboards/integration.html",
    "dashboards/e2e.html",
  ];
  for (const name of ["dashboards/coverage.html", "dashboards/e2e.html", "dashboards/integration.html", "dashboards/unit.html", "tools/benchmarking.html"]) {
    assert.deepEqual(normalizedNavbarLinks(join(DOCS, name)), expected, name);
  }
});

test("dashboard footers expose the Codecov link", () => {
  const expected = "https://codecov.io/gh/BaiGanio/aperio";
  for (const name of ["dashboards/coverage.html", "dashboards/e2e.html", "dashboards/integration.html", "dashboards/unit.html", "tools/benchmarking.html"]) {
    assert.equal(footerLinks(join(DOCS, name)).filter((href) => href === expected).length, 1, name);
    assert.doesNotMatch(readFileSync(join(DOCS, name), "utf8").match(/<nav\b[\s\S]*?<\/nav>/i)?.[0] || "", /codecov/i, name);
  }
});

test("evaluation and tour navbars use their canonical hubs", () => {
  for (const path of htmlFiles(join(DOCS, "evaluate"))) {
    assert.deepEqual(navbarLinks(path).slice(0, 3), ["../index.html", "../guides.html", "../guides.html#evaluate"], relative(DOCS, path));
  }
  for (const path of htmlFiles(join(DOCS, "tours"))) {
    assert.deepEqual(navbarLinks(path).slice(0, 3), ["../index.html", "../guides.html", "../guides.html#tours"], relative(DOCS, path));
  }
});

test("every docs theme switcher loads the shared theme implementation", () => {
  const missing = htmlFiles()
    .filter((path) => readFileSync(path, "utf8").includes("theme-btn"))
    .filter((path) => !/<script src="(?:\.\.\/)*scripts\.js"><\/script>/.test(readFileSync(path, "utf8")))
    .map((path) => relative(ROOT, path));

  assert.deepEqual(missing, []);
});

test("shared theme implementation restores and persists the selected docs theme", () => {
  const source = readFileSync(join(DOCS, "scripts.js"), "utf8").split("/* ── Mobile nav ── */")[0];
  const storage = new Map([["aperio-landing-theme", "aurora"]]);
  const buttons = ["dark", "light", "aurora", "system"].map((theme) => ({
    dataset: { theme },
    active: false,
    attributes: {},
    classList: { toggle(_name, active) { this.owner.active = active; }, owner: null },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(_name, listener) { this.listener = listener; },
  }));
  buttons.forEach((button) => { button.classList.owner = button; });
  const root = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
  const context = vm.createContext({
    document: { documentElement: root, querySelectorAll: () => buttons },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
  });

  new vm.Script(source, { filename: "docs/scripts.js" }).runInContext(context);
  assert.equal(root.attributes["data-theme"], "aurora");
  assert.equal(buttons.find((button) => button.dataset.theme === "aurora").active, true);

  buttons.find((button) => button.dataset.theme === "light").listener();
  assert.equal(root.attributes["data-theme"], "light");
  assert.equal(storage.get("aperio-landing-theme"), "light");
});

test("test dashboards use the shared dashboard stylesheet without inline CSS", () => {
  for (const name of ["dashboards/coverage.html", "dashboards/e2e.html", "dashboards/integration.html", "dashboards/unit.html"]) {
    const html = readFileSync(join(DOCS, name), "utf8");
    assert.match(html, /<link rel="stylesheet" href="styles\.css">/);
    assert.doesNotMatch(html, /<style(?:\s[^>]*)?>/);
  }
});

test("model-tier viewer delegates theme persistence to the shared implementation", () => {
  const html = readFileSync(join(DOCS, "tools/benchmarking.html"), "utf8");
  assert.doesNotMatch(html, /Theme switcher — mirrors the landing page/);
});

test("shared evaluate CSS owns the repeated print baseline", () => {
  const css = readFileSync(join(DOCS, "styles-evaluate.css"), "utf8");
  assert.match(css, /@media print/);
  assert.match(css, /body\{background:#fff;color:#000;font-size:12px\}/);

  for (const path of htmlFiles().filter((file) => file.includes(`${join("docs", "evaluate")}`) || file.includes(`${join("docs", "exam")}`))) {
    assert.doesNotMatch(readFileSync(path, "utf8"), /body\s*\{\s*background\s*:\s*#fff\s*;\s*color\s*:\s*#000\s*;\s*font-size\s*:\s*12px/);
  }
});

test("unit dashboard copy and commands describe unit tests", () => {
  const html = readFileSync(join(DOCS, "dashboards/unit.html"), "utf8");
  assert.match(html, />Unit<\/a>/);
  assert.match(html, /<strong>unit run<\/strong>/);
  assert.match(html, /npm run unit:dashboard/);
  assert.doesNotMatch(html, /Integration tests wire real modules together/);
});
