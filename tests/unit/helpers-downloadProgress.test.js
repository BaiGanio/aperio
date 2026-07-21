import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDownloadProgress, stripAnsi } from "../../lib/helpers/downloadProgress.js";

test("parses quantitative download progress and calculates ETA", () => {
  const result = parseDownloadProgress("download: 1.5 GiB / 6 GiB (25%)", {
    startedAt: Date.now() - 10_000,
    downloadedBytes: 500 * 1024 ** 2,
  });
  assert.equal(result.downloadedBytes, 1.5 * 1024 ** 3);
  assert.equal(result.totalBytes, 6 * 1024 ** 3);
  assert.equal(result.percent, 25);
  assert.ok(result.speedBytesPerSecond > 0);
  assert.ok(result.etaSeconds > 0);
});

test("keeps percentage-only lines quantitative when a total was seen", () => {
  const result = parseDownloadProgress("42%", { totalBytes: 1000, downloadedBytes: 200, startedAt: Date.now() - 1000 });
  assert.equal(result.downloadedBytes, 420);
  assert.equal(result.totalBytes, 1000);
  assert.equal(result.percent, 42);
});

test("supports indeterminate activity and strips terminal control sequences", () => {
  assert.equal(stripAnsi("\u001b[2K\u001b[1G42%"), "42%");
  const result = parseDownloadProgress("received 12 MiB");
  assert.equal(result.downloadedBytes, 12 * 1024 ** 2);
  assert.equal(result.indeterminate, true);
  assert.equal(result.totalBytes, undefined);
});

test("only marks a transfer resumed when the prior cache state says so", () => {
  assert.equal(parseDownloadProgress("1 MiB / 4 MiB", { startedAt: Date.now() }).resumed, false);
  assert.equal(parseDownloadProgress("2 MiB / 4 MiB", { downloadedBytes: 1 * 1024 ** 2, resumed: true }).resumed, true);
});
