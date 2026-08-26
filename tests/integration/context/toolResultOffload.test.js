import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createArtifactStore } from "../../../lib/context/artifactStore.js";
import { createToolResultOffloader } from "../../../lib/context/toolResultOffload.js";

const roots = [];

function fixture({ tokenLimit = 40, byteLimit = 10_000 } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), "aperio-offload-"));
  roots.push(rootDir);
  let nextId = 0;
  const artifactStore = createArtifactStore({
    rootDir,
    idFactory: () => `artifact-${++nextId}`,
    now: () => new Date("2026-07-06T12:00:00.000Z"),
  });
  const offload = createToolResultOffloader({ artifactStore, tokenLimit, byteLimit });
  return { artifactStore, offload };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const context = {
  toolName: "run_shell",
  scope: "session",
  ownerId: "session-1",
  contextWindow: 32_000,
};

describe("tool-result offloading", () => {
  test("leaves a small result unchanged without creating an artifact", () => {
    const { artifactStore, offload } = fixture();
    const original = "short result";
    const out = offload(original, context);

    assert.equal(out.result, original);
    assert.deepEqual(out.artifacts, []);
    assert.deepEqual(artifactStore.listIds({ scope: "session", ownerId: "session-1" }), []);
  });

  test("stores a complete large result and returns a bounded head/tail preview", () => {
    const { artifactStore, offload } = fixture();
    const original = [
      "HEAD-LINE",
      ...Array.from({ length: 200 }, (_, i) => `middle-${i} ${"x".repeat(24)}`),
      "TAIL-LINE",
    ].join("\n");
    const out = offload(original, context);

    assert.equal(out.artifacts.length, 1);
    assert.match(out.result, /HEAD-LINE/);
    assert.match(out.result, /TAIL-LINE/);
    assert.match(out.result, /Artifact: artifact-1/);
    assert.ok(out.result.length < original.length);

    const stored = artifactStore.read({
      scope: "session",
      ownerId: "session-1",
      artifactId: out.artifacts[0].id,
    });
    assert.equal(stored.content.toString("utf8"), original);
    assert.equal(stored.metadata.sourceTool, "run_shell");
  });

  test("tells recall callers to narrow retrieval before reading the full artifact", () => {
    const { offload } = fixture();
    const out = offload("Nimbus memory ".repeat(500), { ...context, toolName: "recall" });

    assert.equal(out.artifacts.length, 1);
    assert.match(out.result, /narrower recall/i);
    assert.match(out.result, /lower limit/i);
    assert.match(out.result, /artifact retrieval only if/i);
    assert.ok(
      out.result.search(/narrower recall/i) < out.result.search(/artifact retrieval only if/i),
      "bounded retrieval guidance must precede full-artifact retrieval",
    );
  });

  test("uses one quarter of a small context window as the effective token limit", () => {
    const { offload } = fixture({ tokenLimit: 20_000 });
    const original = "token ".repeat(1_000);
    const out = offload(original, { ...context, contextWindow: 2_000 });
    assert.equal(out.artifacts.length, 1);
  });

  test("offloads on byte limit even when token offloading is disabled", () => {
    const { offload } = fixture({ tokenLimit: 0, byteLimit: 100 });
    const out = offload("é".repeat(80), context);
    assert.equal(out.artifacts.length, 1);
    assert.equal(out.artifacts[0].byteCount, 160);
  });

  test("preserves non-text blocks in a mixed result", () => {
    const { artifactStore, offload } = fixture();
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    };
    const original = [
      { type: "text", text: "large text ".repeat(300) },
      image,
    ];
    const out = offload(original, { ...context, toolName: "fetch_github_issue" });

    assert.equal(out.artifacts.length, 1);
    assert.match(out.result[0].text, /Artifact: artifact-1/);
    assert.strictEqual(out.result[1], image);
    assert.equal(
      artifactStore.read({
        scope: "session",
        ownerId: "session-1",
        artifactId: "artifact-1",
      }).content.toString(),
      original[0].text,
    );
  });

  test("keeps session and background-run ownership isolated", () => {
    const { artifactStore, offload } = fixture();
    const large = "owned result ".repeat(300);
    const session = offload(large, context);
    const run = offload(large, {
      ...context,
      scope: "run",
      ownerId: "background-run-1",
    });

    assert.deepEqual(artifactStore.listIds({ scope: "session", ownerId: "session-1" }), [session.artifacts[0].id]);
    assert.deepEqual(artifactStore.listIds({ scope: "run", ownerId: "background-run-1" }), [run.artifacts[0].id]);
    assert.equal(artifactStore.read({
      scope: "run",
      ownerId: "another-run",
      artifactId: run.artifacts[0].id,
    }), null);
  });

  test("redacts secrets before persistence and preview generation", () => {
    const { artifactStore, offload } = fixture({ tokenLimit: 10 });
    const secret = "ghp_" + "a".repeat(36);
    const original = `${secret}\n${"large output ".repeat(300)}\n${secret}`;
    const out = offload(original, context);
    const stored = artifactStore.read({
      scope: "session",
      ownerId: "session-1",
      artifactId: out.artifacts[0].id,
    }).content.toString();

    assert.doesNotMatch(stored, /ghp_/);
    assert.match(stored, /\[REDACTED:github-token\]/);
    assert.doesNotMatch(out.result, /ghp_/);
  });

  test("does not offload error results or mutate the input array", () => {
    const { offload } = fixture({ tokenLimit: 5 });
    const error = `❌ ${"failure ".repeat(100)}`;
    assert.equal(offload(error, context).result, error);

    const blocks = [{ type: "text", text: "large text ".repeat(300) }];
    const out = offload(blocks, context);
    assert.notStrictEqual(out.result, blocks);
    assert.doesNotMatch(blocks[0].text, /Artifact:/);
  });
});
