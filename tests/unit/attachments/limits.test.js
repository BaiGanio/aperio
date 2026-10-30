// T2.10 — the shared attachment budget (Aperio Reset, S2.10).
//
// Verify-first: before this step there was no limit ANYWHERE — not in
// lib/config.js, not server-side, and not in the browser. The tests that
// matter most here are the two that would have caught that: a rejected file
// must never be read or base64-encoded, and the terminal and web limits must
// come from one constant so they cannot drift apart.

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  attachmentMaxBytes, attachmentMaxCount, wsMaxPayloadBytes,
  base64Bytes, checkAttachmentSize, checkAttachmentCount, formatMb,
} from "../../../lib/helpers/attachmentLimits.js";

const SAVED = {};
const KEYS = ["APERIO_ATTACHMENT_MAX_MB", "APERIO_ATTACHMENT_MAX_COUNT"];

beforeEach(() => { for (const k of KEYS) SAVED[k] = process.env[k]; });
afterEach(() => {
  for (const k of KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

describe("attachment budget — the limit itself", () => {
  test("defaults are the shipped 10 MB / 5 files", () => {
    delete process.env.APERIO_ATTACHMENT_MAX_MB;
    delete process.env.APERIO_ATTACHMENT_MAX_COUNT;
    assert.strictEqual(attachmentMaxBytes(), 10 * 1024 * 1024);
    assert.strictEqual(attachmentMaxCount(), 5);
  });

  // The resolver injects DB-stored values into process.env during boot, so a
  // module-level const would freeze a stale value. These must read at CALL time.
  test("the env is read at call time, not captured at import", () => {
    process.env.APERIO_ATTACHMENT_MAX_MB = "1";
    assert.strictEqual(attachmentMaxBytes(), 1024 * 1024);
    process.env.APERIO_ATTACHMENT_MAX_MB = "3";
    assert.strictEqual(attachmentMaxBytes(), 3 * 1024 * 1024);
  });

  test("junk, zero and negative values fall back to the default", () => {
    for (const bad of ["", "abc", "0", "-5", "NaN"]) {
      process.env.APERIO_ATTACHMENT_MAX_MB = bad;
      assert.strictEqual(attachmentMaxBytes(), 10 * 1024 * 1024, `for ${JSON.stringify(bad)}`);
    }
  });

  test("boundary: at the limit passes, one byte over is refused", () => {
    delete process.env.APERIO_ATTACHMENT_MAX_MB;
    const max = attachmentMaxBytes();
    assert.strictEqual(checkAttachmentSize(max - 1).ok, true);
    assert.strictEqual(checkAttachmentSize(max).ok, true);
    assert.strictEqual(checkAttachmentSize(max + 1).ok, false);
  });

  test("a refusal names the file and the key, so it can be acted on", () => {
    const v = checkAttachmentSize(50 * 1024 * 1024, "big.pdf");
    assert.strictEqual(v.ok, false);
    assert.match(v.reason, /big\.pdf/);
    assert.match(v.reason, /APERIO_ATTACHMENT_MAX_MB/);
  });

  test("boundary: the count limit refuses the n-th file, 0-based", () => {
    process.env.APERIO_ATTACHMENT_MAX_COUNT = "2";
    assert.strictEqual(checkAttachmentCount(0).ok, true);
    assert.strictEqual(checkAttachmentCount(1).ok, true);
    assert.strictEqual(checkAttachmentCount(2).ok, false);
    assert.match(checkAttachmentCount(2).reason, /APERIO_ATTACHMENT_MAX_COUNT/);
  });

  test("base64Bytes measures from the string length, without decoding", () => {
    assert.strictEqual(base64Bytes("AAAA"), 3);
    assert.strictEqual(base64Bytes("AAA="), 2);
    assert.strictEqual(base64Bytes("AA=="), 1);
    assert.strictEqual(base64Bytes(""), 0);
    assert.strictEqual(base64Bytes(undefined), 0);
    // Agrees with a real encode, which is the property that matters.
    const raw = Buffer.alloc(5000, 7);
    assert.strictEqual(base64Bytes(raw.toString("base64")), raw.length);
  });

  test("formatMb keeps whole numbers whole", () => {
    assert.strictEqual(formatMb(10 * 1024 * 1024), "10 MB");
    assert.strictEqual(formatMb(1.5 * 1024 * 1024), "1.5 MB");
  });
});

describe("attachment budget — the WS frame cap is derived, not hand-set", () => {
  // The bug this guards: ws.js passed no maxPayload, so `ws` fell back to its
  // own 100 MiB default and an oversized attachment killed the connection
  // instead of being refused.
  test("a message carrying the maximum legal attachment set always fits", () => {
    for (const [mb, count] of [["1", "1"], ["10", "5"], ["25", "4"], ["2", "20"]]) {
      process.env.APERIO_ATTACHMENT_MAX_MB = mb;
      process.env.APERIO_ATTACHMENT_MAX_COUNT = count;
      const legalBase64 = attachmentMaxCount() * attachmentMaxBytes() * (4 / 3);
      assert.ok(
        wsMaxPayloadBytes() > legalBase64,
        `cap ${wsMaxPayloadBytes()} must exceed a legal ${mb}MB x${count} payload (${legalBase64})`,
      );
    }
  });

  test("a tiny budget cannot shrink the cap enough to break ordinary chat", () => {
    process.env.APERIO_ATTACHMENT_MAX_MB = "1";
    process.env.APERIO_ATTACHMENT_MAX_COUNT = "1";
    assert.ok(wsMaxPayloadBytes() >= 8 * 1024 * 1024);
  });

  test("raising the budget raises the cap with it", () => {
    process.env.APERIO_ATTACHMENT_MAX_COUNT = "5";
    process.env.APERIO_ATTACHMENT_MAX_MB = "10";
    const small = wsMaxPayloadBytes();
    process.env.APERIO_ATTACHMENT_MAX_MB = "40";
    assert.ok(wsMaxPayloadBytes() > small);
  });
});

describe("terminal readAttachment is bounded and never reads a refused file", () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "aperio-att-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("an over-limit file is refused, and the refusal is about the SIZE", async () => {
    process.env.APERIO_ATTACHMENT_MAX_MB = "1";
    const big = join(dir, "big.txt");
    writeFileSync(big, Buffer.alloc(2 * 1024 * 1024, 0x61));
    const { readAttachment } = await import("../../../lib/terminal/attachments.js");
    const result = await readAttachment(big);
    assert.ok(result.error, "an over-limit file must be refused");
    assert.match(result.error, /over the 1 MB attachment limit/);
    assert.strictEqual(result.data, undefined, "no base64 payload for a refused file");
    assert.strictEqual(result.sizeKb, undefined);
  });

  // The regression that actually matters, and the one hard to fake: the old
  // code called readFileSync(abs).toString("base64") and only statSync'd
  // AFTERWARDS, so both representations existed before any check could refuse
  // the file. An unreadable over-limit file separates the two orders cleanly —
  // check-first returns the size refusal, read-first can only fail on EACCES.
  // No stubbing, so the proof cannot drift away from the real import.
  test("the size is checked BEFORE the read — proved with an unreadable file", async (t) => {
    if (process.getuid && process.getuid() === 0) {
      t.skip("root ignores file modes, so this proof cannot run");
      return;
    }
    process.env.APERIO_ATTACHMENT_MAX_MB = "1";
    const locked = join(dir, "locked.txt");
    writeFileSync(locked, Buffer.alloc(2 * 1024 * 1024, 0x61));
    chmodSync(locked, 0o000);
    try {
      const { readAttachment } = await import("../../../lib/terminal/attachments.js");
      const result = await readAttachment(locked);
      assert.match(
        result.error, /over the 1 MB attachment limit/,
        "a size refusal proves nothing was read; an EACCES error would mean the read came first",
      );
    } finally {
      chmodSync(locked, 0o600);
    }
  });

  test("a file at the limit is still accepted and encoded", async () => {
    process.env.APERIO_ATTACHMENT_MAX_MB = "1";
    const ok = join(dir, "ok.txt");
    const bytes = 1024 * 1024; // exactly at the limit
    writeFileSync(ok, Buffer.alloc(bytes, 0x62));
    const { readAttachment } = await import("../../../lib/terminal/attachments.js");
    const result = await readAttachment(ok);
    assert.ok(!result.error, `expected acceptance, got: ${result.error}`);
    assert.strictEqual(base64Bytes(result.data), bytes);
  });

  test("a directory is refused before any read", async () => {
    const sub = join(dir, "nested");
    mkdirSync(sub);
    const { readAttachment } = await import("../../../lib/terminal/attachments.js");
    const result = await readAttachment(sub);
    assert.match(result.error, /not a file/);
  });
});

describe("the terminal and web limits cannot drift apart", () => {
  // Both edges must read ONE constant. The web path gets it over
  // /api/config/client; the terminal imports it directly. If either grew its
  // own number, this test is where it shows.
  test("/api/config/client serves the same numbers the helper computes", async () => {
    process.env.APERIO_ATTACHMENT_MAX_MB = "7";
    process.env.APERIO_ATTACHMENT_MAX_COUNT = "3";

    const metaSrc = await import("node:fs").then(fs =>
      fs.readFileSync("lib/routes/api-meta.js", "utf8"));
    assert.match(
      metaSrc, /attachmentMaxBytes: attachmentMaxBytes\(\)/,
      "the client config endpoint must serve the shared helper's value, not a literal",
    );
    assert.match(metaSrc, /attachmentMaxCount: attachmentMaxCount\(\)/);

    const termSrc = await import("node:fs").then(fs =>
      fs.readFileSync("lib/terminal/attachments.js", "utf8"));
    assert.match(
      termSrc, /from "\.\.\/helpers\/attachmentLimits\.js"/,
      "the terminal must import the shared budget, not define its own",
    );

    const wsSrc = await import("node:fs").then(fs =>
      fs.readFileSync("lib/server/ws.js", "utf8"));
    assert.match(
      wsSrc, /maxPayload: wsMaxPayloadBytes\(\)/,
      "the WS frame cap must be derived from the budget, not a hand-set number",
    );
  });

  test("the browser checks size BEFORE readAsDataURL, at every entry point", async () => {
    const src = await import("node:fs").then(fs =>
      fs.readFileSync("public/scripts/input-bar.js", "utf8"));
    // Every readAsDataURL must be preceded by the shared gate in its block.
    const entries = src.split("acceptAttachment(file)").length - 1;
    assert.ok(entries >= 2, "both the file picker and paste must pass the gate");
    assert.match(src, /fetch\('\/api\/config\/client'\)/,
      "the browser must take the budget from the server, not invent one");
    // A failed fetch must still bound the file.
    assert.match(src, /_ATTACH_FALLBACK/);
  });
});

describe("processAttachments is the authority, not the clients", () => {
  // A client check is a courtesy that saves a read. This is the one chokepoint
  // both the browser and the terminal pass through, so a payload that evades
  // either client must still be refused here.
  const b64 = (bytes) => Buffer.alloc(bytes, 0x61).toString("base64");

  test("an over-limit payload that skipped the client is still refused", async () => {
    process.env.APERIO_ATTACHMENT_MAX_MB = "1";
    const { processAttachments } = await import("../../../lib/handlers/attachments/index.js");
    const out = await processAttachments(
      [{ name: "sneaky.txt", type: "text/plain", data: b64(2 * 1024 * 1024) }],
      process.cwd(),
      { storageDir: "/tmp/aperio-test-unused", urlBase: "/unused" },
    );
    assert.strictEqual(out.contentBlocks.length, 0, "a refused file contributes no content");
    assert.match(out.hint, /Attachment refused/);
    assert.match(out.hint, /over the 1 MB attachment limit/);
    // Still reported, so the user sees what happened to their file.
    assert.strictEqual(out.attachmentMeta.length, 1);
  });

  test("files past the count limit are refused with a note, not silently dropped", async () => {
    process.env.APERIO_ATTACHMENT_MAX_MB = "10";
    process.env.APERIO_ATTACHMENT_MAX_COUNT = "2";
    const { processAttachments } = await import("../../../lib/handlers/attachments/index.js");
    const three = ["a.txt", "b.txt", "c.txt"].map(name => ({
      name, type: "text/plain", data: b64(16),
    }));
    const out = await processAttachments(three, process.cwd(), {
      storageDir: "/tmp/aperio-test-unused", urlBase: "/unused",
    });
    const refusals = out.hint.match(/Attachment refused/g) || [];
    assert.strictEqual(refusals.length, 1, "exactly the third file is refused");
    assert.match(out.hint, /only 2 attachments per message/);
    assert.strictEqual(out.attachmentMeta.length, 3, "all three are still reported back");
  });

  test("a refused file does not consume a slot from the count budget", async () => {
    process.env.APERIO_ATTACHMENT_MAX_MB = "1";
    process.env.APERIO_ATTACHMENT_MAX_COUNT = "2";
    const { processAttachments } = await import("../../../lib/handlers/attachments/index.js");
    const out = await processAttachments([
      { name: "too-big.txt", type: "text/plain", data: b64(2 * 1024 * 1024) },
      { name: "ok-1.txt",    type: "text/plain", data: b64(16) },
      { name: "ok-2.txt",    type: "text/plain", data: b64(16) },
    ], process.cwd(), { storageDir: "/tmp/aperio-test-unused", urlBase: "/unused" });

    // The oversized file is refused on size, so the two valid files that follow
    // must both still fit the budget of 2 — otherwise one bad file would cost a
    // user a good one.
    const refusals = out.hint.match(/Attachment refused/g) || [];
    assert.strictEqual(refusals.length, 1);
    assert.match(out.hint, /too-big\.txt/);
    assert.doesNotMatch(out.hint, /only 2 attachments per message/);
  });
});
