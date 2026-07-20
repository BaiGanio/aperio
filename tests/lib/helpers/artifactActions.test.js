import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  resolveScratchArtifactUrl,
  revealScratchArtifact,
} from "../../../lib/helpers/artifactActions.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aperio-artifact-actions-"));
  const folder = join(root, "var", "scratch", "session-1");
  mkdirSync(folder, { recursive: true });
  const file = join(folder, "hello world.html");
  writeFileSync(file, "<!doctype html><title>Hello</title>");
  return {
    root,
    folder: realpathSync(folder),
    file: realpathSync(file),
  };
}

describe("resolveScratchArtifactUrl", () => {
  test("maps an encoded scratch URL to an existing generated file", () => {
    const { root, file } = fixture();
    assert.equal(
      resolveScratchArtifactUrl("/scratch/session-1/hello%20world.html", root),
      file,
    );
  });

  test("rejects paths outside the scratch route", () => {
    const { root } = fixture();
    assert.throws(() => resolveScratchArtifactUrl("/uploads/session-1/file.html", root), /scratch artifact/i);
  });

  test("rejects traversal, including encoded traversal", () => {
    const { root } = fixture();
    for (const url of [
      "/scratch/../package.json",
      "/scratch/%2e%2e/package.json",
      "/scratch/session-1/%2e%2e/%2e%2e/package.json",
    ]) {
      assert.throws(() => resolveScratchArtifactUrl(url, root), /invalid|outside/i, url);
    }
  });

  test("rejects missing files and directories", () => {
    const { root } = fixture();
    assert.throws(() => resolveScratchArtifactUrl("/scratch/session-1/missing.html", root), /not found/i);
    assert.throws(() => resolveScratchArtifactUrl("/scratch/session-1", root), /invalid|file/i);
  });
});

describe("revealScratchArtifact", () => {
  test("uses macOS Finder reveal without invoking a shell", async () => {
    const { root, file } = fixture();
    const calls = [];
    await revealScratchArtifact("/scratch/session-1/hello%20world.html", {
      root,
      platform: "darwin",
      execFileImpl: async (...args) => calls.push(args),
    });
    assert.deepEqual(calls, [["open", ["-R", file]]]);
  });

  test("opens the containing folder on Linux", async () => {
    const { root, folder } = fixture();
    const calls = [];
    await revealScratchArtifact("/scratch/session-1/hello%20world.html", {
      root,
      platform: "linux",
      execFileImpl: async (...args) => calls.push(args),
    });
    assert.deepEqual(calls, [["xdg-open", [folder]]]);
  });

  test("selects the file in Windows Explorer", async () => {
    const { root, file } = fixture();
    const calls = [];
    await revealScratchArtifact("/scratch/session-1/hello%20world.html", {
      root,
      platform: "win32",
      execFileImpl: async (...args) => calls.push(args),
    });
    assert.deepEqual(calls, [["explorer.exe", [`/select,${file}`]]]);
  });
});
