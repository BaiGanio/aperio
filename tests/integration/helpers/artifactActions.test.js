import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  resolveGeneratedArtifactUrl,
  resolveScratchArtifactUrl,
  revealScratchArtifact,
} from "../../../lib/helpers/artifactActions.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aperio-artifact-actions-"));
  const folder = join(root, "var", "scratch", "session-1");
  mkdirSync(folder, { recursive: true });
  const file = join(folder, "hello world.html");
  writeFileSync(file, "<!doctype html><title>Hello</title>");
  const uploads = join(root, "var", "uploads");
  mkdirSync(uploads, { recursive: true });
  const upload = join(uploads, "93722e91-table.xlsx");
  writeFileSync(upload, "xlsx");
  return {
    root,
    folder: realpathSync(folder),
    file: realpathSync(file),
    upload: realpathSync(upload),
  };
}

describe("resolveGeneratedArtifactUrl", () => {
  test("accepts both session scratch and generated upload URLs", () => {
    const { root, file, upload } = fixture();
    assert.equal(resolveGeneratedArtifactUrl("/scratch/session-1/hello%20world.html", root), file);
    assert.equal(resolveGeneratedArtifactUrl("/uploads/93722e91-table.xlsx", root), upload);
  });

  test("keeps uploads traversal and nested paths outside the artifact boundary", () => {
    const { root } = fixture();
    for (const url of ["/uploads/../package.json", "/uploads/%2e%2e/package.json", "/uploads/nested/file.xlsx"]) {
      assert.throws(() => resolveGeneratedArtifactUrl(url, root), /invalid|outside/i, url);
    }
  });
});

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

  test("rejects a symlink inside scratch that escapes the workspace", () => {
    const { root } = fixture();
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "top secret");
    symlinkSync(secret, join(root, "var", "scratch", "session-1", "escape.html"));

    assert.throws(
      () => resolveScratchArtifactUrl("/scratch/session-1/escape.html", root),
      /outside/i,
    );
  });

  test("rejects a sibling directory that shares the scratch root's prefix", () => {
    const { root } = fixture();
    const sibling = join(root, "var", "scratch-evil", "session-1");
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "hello world.html"), "<!doctype html>");

    assert.throws(
      () => resolveScratchArtifactUrl("/scratch/../scratch-evil/session-1/hello%20world.html", root),
      /invalid|outside/i,
    );
  });

  test("reports a missing scratch root as not found rather than throwing raw", () => {
    const root = mkdtempSync(join(tmpdir(), "aperio-artifact-actions-empty-"));
    assert.throws(
      () => resolveScratchArtifactUrl("/scratch/session-1/hello.html", root),
      /not found/i,
    );
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

  test("tolerates Explorer exit code 1 after revealing the file", async () => {
    const { root, file } = fixture();
    const error = Object.assign(new Error("Command failed: explorer.exe"), { code: 1 });

    await assert.doesNotReject(() => revealScratchArtifact(
      "/scratch/session-1/hello%20world.html",
      {
        root,
        platform: "win32",
        execFileImpl: async (command, args) => {
          assert.deepEqual([command, args], ["explorer.exe", [`/select,${file}`]]);
          throw error;
        },
      },
    ));
  });

  test("surfaces Windows Explorer launch failures", async () => {
    const { root } = fixture();
    const error = Object.assign(new Error("spawn explorer.exe ENOENT"), { code: "ENOENT" });

    await assert.rejects(
      revealScratchArtifact("/scratch/session-1/hello%20world.html", {
        root,
        platform: "win32",
        execFileImpl: async () => { throw error; },
      }),
      error,
    );
  });
});
