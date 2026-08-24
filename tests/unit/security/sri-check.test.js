// tests/unit/security/sri-check.test.js
//
// #466 — CDN assets pinned with hand-written Subresource Integrity hashes.
// Nothing verified them: a version bump that forgets the hash fails *silently*
// — the browser drops the asset, so icons vanish or a diagram never renders,
// with no console error a user reads and no CI failure.
//
// Bootstrap Icons has since been vendored out of the CDN entirely (SRI could
// not cover the .woff2 the stylesheet went on to fetch), leaving the Mermaid
// bundle in index.html as the one remaining pin. The multi-page and
// cross-file-conflict cases below therefore run on synthetic fixtures — they
// still guard the parser against the day a second pin comes back.
//
// scripts/check-sri.js closes that gap. The network fetch lives behind an
// injectable seam so this suite never touches jsDelivr: every case below runs
// against a fake fetch, and the real fetch is exercised by `npm run check:sri`.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseIntegrityRefs,
  findHashConflicts,
  verifyRefs,
  summarize,
  checkSri,
} from "../../../scripts/check-sri.js";

const ICON_URL = "https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css";
const MERMAID_URL = "https://cdn.jsdelivr.net/npm/mermaid@11.12.0/dist/mermaid.min.js";

const ICON_BYTES = Buffer.from("/* bootstrap icons */");
const MERMAID_BYTES = Buffer.from("/* mermaid bundle */");

const sri = (algorithm, bytes) => `${algorithm}-${createHash(algorithm).update(bytes).digest("base64")}`;

const ICON_SRI = sri("sha384", ICON_BYTES);
const MERMAID_SRI = sri("sha384", MERMAID_BYTES);

/** A fake fetch over a { url -> bytes | Error | httpStatus } table. */
function fakeFetch(table, log = []) {
  return async (url) => {
    log.push(url);
    const entry = table[url];
    if (entry === undefined) throw new Error(`unexpected fetch: ${url}`);
    if (entry instanceof Error) throw entry;
    if (typeof entry === "number") {
      return { ok: false, status: entry, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return { ok: true, status: 200, arrayBuffer: async () => entry.buffer.slice(entry.byteOffset, entry.byteOffset + entry.byteLength) };
  };
}

const page = (integrity) => `<!doctype html>
<html><head>
  <link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin />
  <link rel="stylesheet" href="${ICON_URL}"
        integrity="${integrity}"
        crossorigin="anonymous" />
  <link rel="stylesheet" href="index.css" />
</head><body></body></html>`;

describe("parsing", () => {
  test("finds every integrity-bearing tag and ignores the rest", () => {
    const html = `${page(ICON_SRI)}
      <script src="${MERMAID_URL}" defer integrity="${MERMAID_SRI}" crossorigin="anonymous"></script>`;
    const refs = parseIntegrityRefs(html, "index.html");

    assert.equal(refs.length, 2);
    assert.deepEqual(refs.map((r) => r.url), [ICON_URL, MERMAID_URL]);
    assert.deepEqual(refs.map((r) => r.source), ["index.html", "index.html"]);
    // The line number is what a developer needs to jump to the broken pin.
    assert.equal(refs[0].line, 4);
    assert.deepEqual(refs[0].hashes, [{ algorithm: "sha384", digest: ICON_SRI.slice("sha384-".length) }]);
  });

  test("an integrity attribute may carry several acceptable hashes", () => {
    const html = page(`sha384-${"A".repeat(64)} ${ICON_SRI}`);
    const [ref] = parseIntegrityRefs(html, "index.html");
    assert.equal(ref.hashes.length, 2);
  });
});

describe("cross-file consistency", () => {
  test("the same URL pinned to two different hashes is a conflict", () => {
    const refs = [
      ...parseIntegrityRefs(page(ICON_SRI), "index.html"),
      ...parseIntegrityRefs(page(ICON_SRI), "setup.html"),
      ...parseIntegrityRefs(page(`sha384-${"B".repeat(64)}`), "codegraph-atlas.html"),
    ];
    const conflicts = findHashConflicts(refs);

    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].url, ICON_URL);
    assert.deepEqual(conflicts[0].variants.map((v) => v.sources.length).sort(), [1, 2]);
  });

  test("the same URL pinned to the same hash everywhere is fine", () => {
    const refs = [
      ...parseIntegrityRefs(page(ICON_SRI), "index.html"),
      ...parseIntegrityRefs(page(ICON_SRI), "setup.html"),
    ];
    assert.deepEqual(findHashConflicts(refs), []);
  });
});

describe("verification against the bytes", () => {
  test("a matching hash passes", async () => {
    const refs = parseIntegrityRefs(page(ICON_SRI), "index.html");
    const [result] = await verifyRefs(refs, { fetchImpl: fakeFetch({ [ICON_URL]: ICON_BYTES }) });
    assert.equal(result.status, "ok");
  });

  test("a corrupted hash is reported as a mismatch, with the digest that would fix it", async () => {
    const refs = parseIntegrityRefs(page(`sha384-${"B".repeat(64)}`), "index.html");
    const [result] = await verifyRefs(refs, { fetchImpl: fakeFetch({ [ICON_URL]: ICON_BYTES }) });

    assert.equal(result.status, "mismatch");
    assert.equal(result.actual, ICON_SRI);
    assert.match(result.detail, /index\.html/);
  });

  test("any one of several declared hashes matching is enough", async () => {
    const refs = parseIntegrityRefs(page(`sha384-${"A".repeat(64)} ${ICON_SRI}`), "index.html");
    const [result] = await verifyRefs(refs, { fetchImpl: fakeFetch({ [ICON_URL]: ICON_BYTES }) });
    assert.equal(result.status, "ok");
  });

  test("an unsupported algorithm is an error, not a silent pass", async () => {
    const refs = parseIntegrityRefs(page("md5-abc123"), "index.html");
    const [result] = await verifyRefs(refs, { fetchImpl: fakeFetch({}) });
    assert.equal(result.status, "unsupported-algorithm");
  });

  test("a relative URL is verified from disk, without the network", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aperio-sri-"));
    try {
      await writeFile(join(dir, "vendor.js"), ICON_BYTES);
      const html = `<script src="/vendor.js" integrity="${ICON_SRI}"></script>`;
      const refs = parseIntegrityRefs(html, "index.html");
      const [result] = await verifyRefs(refs, {
        localRoot: dir,
        fetchImpl: () => assert.fail("a same-origin asset must not be fetched over the network"),
      });
      assert.equal(result.status, "ok");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("could-not-fetch is not the same as the-hash-is-wrong", () => {
  test("a network error is 'unreachable' after the retries are spent", async () => {
    const log = [];
    const refs = parseIntegrityRefs(page(ICON_SRI), "index.html");
    const [result] = await verifyRefs(refs, {
      fetchImpl: fakeFetch({ [ICON_URL]: new Error("ECONNRESET") }, log),
      retries: 2,
      retryDelayMs: 0,
    });

    assert.equal(result.status, "unreachable");
    assert.equal(log.length, 3, "one attempt plus two retries");
  });

  test("a transient failure that recovers on a retry passes", async () => {
    let calls = 0;
    const refs = parseIntegrityRefs(page(ICON_SRI), "index.html");
    const [result] = await verifyRefs(refs, {
      retries: 2,
      retryDelayMs: 0,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) throw new Error("ETIMEDOUT");
        return { ok: true, status: 200, arrayBuffer: async () => ICON_BYTES.buffer.slice(ICON_BYTES.byteOffset, ICON_BYTES.byteOffset + ICON_BYTES.byteLength) };
      },
    });
    assert.equal(result.status, "ok");
  });

  test("a 5xx is an outage: unreachable", async () => {
    const refs = parseIntegrityRefs(page(ICON_SRI), "index.html");
    const [result] = await verifyRefs(refs, {
      fetchImpl: fakeFetch({ [ICON_URL]: 503 }),
      retries: 0,
      retryDelayMs: 0,
    });
    assert.equal(result.status, "unreachable");
  });

  test("a 404 is not an outage — the pinned version is gone", async () => {
    const refs = parseIntegrityRefs(page(ICON_SRI), "index.html");
    const [result] = await verifyRefs(refs, {
      fetchImpl: fakeFetch({ [ICON_URL]: 404 }),
      retries: 0,
      retryDelayMs: 0,
    });
    assert.equal(result.status, "missing");
  });
});

describe("exit status", () => {
  const at = (status) => ({ status, ref: { source: "index.html", line: 4, url: ICON_URL } });

  test("all green exits 0", () => {
    assert.equal(summarize([at("ok"), at("ok")], []).exitCode, 0);
  });

  test("an unreachable CDN warns but never blocks an unrelated PR", () => {
    const summary = summarize([at("ok"), at("unreachable")], []);
    assert.equal(summary.exitCode, 0);
    assert.equal(summary.unverified, 1);
  });

  test("a wrong hash fails the build", () => {
    assert.equal(summarize([at("ok"), at("mismatch")], []).exitCode, 1);
  });

  test("a vanished pinned version fails the build", () => {
    assert.equal(summarize([at("missing")], []).exitCode, 1);
  });

  test("a cross-file hash conflict fails the build even when every fetch passes", () => {
    const conflicts = [{ url: ICON_URL, variants: [] }];
    assert.equal(summarize([at("ok"), at("ok")], conflicts).exitCode, 1);
  });
});

describe("end to end over a directory of pages", () => {
  test("two pages agreeing and one page left behind is caught", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aperio-sri-"));
    try {
      await writeFile(join(dir, "index.html"), page(ICON_SRI));
      await writeFile(join(dir, "setup.html"), page(ICON_SRI));
      await writeFile(join(dir, "codegraph-atlas.html"), page(`sha384-${"B".repeat(64)}`));

      const summary = await checkSri({
        dir,
        fetchImpl: fakeFetch({ [ICON_URL]: ICON_BYTES }),
        retries: 0,
        retryDelayMs: 0,
      });

      assert.equal(summary.exitCode, 1);
      assert.equal(summary.conflicts.length, 1);
      assert.equal(summary.results.filter((r) => r.status === "mismatch").length, 1);
      assert.equal(summary.results.filter((r) => r.status === "ok").length, 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the real public/ pages parse, and every pin is a supported algorithm", async () => {
    // Reads the committed HTML but never the network: proves the parser keeps
    // working as the pages change, without making `npm test` need jsDelivr.
    const refs = await checkSri({ parseOnly: true });
    // A check that silently finds nothing is worse than no check: if the last
    // pin is ever removed or its tag reshaped past the parser, this fails loudly
    // rather than reporting a cheerful "0 verified".
    assert.ok(refs.refs.length >= 1, `the parser found no pins at all in public/`);
    assert.ok(
      refs.refs.some((r) => r.url === MERMAID_URL),
      `expected the committed Mermaid pin, saw ${refs.refs.map((r) => r.url).join(", ") || "nothing"}`,
    );
    for (const ref of refs.refs) {
      for (const h of ref.hashes) {
        assert.ok(["sha256", "sha384", "sha512"].includes(h.algorithm), `${ref.source}: ${h.algorithm}`);
      }
    }
    assert.deepEqual(refs.conflicts, [], "the committed pages must agree on every shared URL");
  });
});
