import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactStore } from "../../../lib/context/artifactStore.js";
import {
  ARTIFACT_READ_TOOL_NAME,
  ARTIFACT_RETRIEVAL_LIMITS,
  appendArtifactReadTool,
  createArtifactReader,
} from "../../../lib/context/artifactRetrieval.js";

const roots = [];

function fixture() {
  const rootDir = mkdtempSync(join(tmpdir(), "aperio-artifact-read-"));
  roots.push(rootDir);
  let nextId = 0;
  const store = createArtifactStore({
    rootDir,
    idFactory: () => `artifact-${++nextId}`,
  });
  return { store, readArtifact: createArtifactReader({ artifactStore: store }) };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("chunked artifact retrieval", () => {
  test("attaches provider schemas only after an artifact is offloaded", () => {
    const base = [{ name: "recall" }];
    assert.equal(appendArtifactReadTool(base, "mcp", false), base);
    assert.deepEqual(
      appendArtifactReadTool(base, "mcp", true).map(tool => tool.name),
      ["recall", ARTIFACT_READ_TOOL_NAME],
    );
    assert.equal(
      appendArtifactReadTool([], "anthropic", true)[0].name,
      ARTIFACT_READ_TOOL_NAME,
    );
    assert.equal(
      appendArtifactReadTool([], "ollama", true)[0].function.name,
      ARTIFACT_READ_TOOL_NAME,
    );
    assert.equal(
      appendArtifactReadTool([{ functionDeclarations: [] }], "gemini", true)
        [0].functionDeclarations[0].name,
      ARTIFACT_READ_TOOL_NAME,
    );
  });

  test("paginates content and reports end-of-content", () => {
    const { store, readArtifact } = fixture();
    const metadata = store.put({
      scope: "session",
      ownerId: "session-1",
      sourceTool: "fetch_url",
      content: "abcdefghij",
    });
    const owner = { scope: "session", ownerId: "session-1" };

    const first = readArtifact({ artifact_id: metadata.id, offset: 0, limit: 4 }, owner);
    assert.match(first, /Bytes: 0-4 of 10/);
    assert.match(first, /Next offset: 4/);
    assert.match(first, /End: false\n\nabcd$/);

    const second = readArtifact({ artifact_id: metadata.id, offset: 4, limit: 20 }, owner);
    assert.match(second, /Bytes: 4-10 of 10/);
    assert.match(second, /End: true\n\nefghij$/);

    const atEnd = readArtifact({ artifact_id: metadata.id, offset: 10 }, owner);
    assert.match(atEnd, /Bytes: 10-10 of 10/);
    assert.match(atEnd, /End: true\n\n$/);
  });

  test("returns the same denial for invalid and cross-session IDs", () => {
    const { store, readArtifact } = fixture();
    const metadata = store.put({
      scope: "session",
      ownerId: "session-a",
      sourceTool: "web_search",
      content: "private result",
    });

    const invalid = readArtifact(
      { artifact_id: "missing-artifact" },
      { scope: "session", ownerId: "session-a" },
    );
    const foreign = readArtifact(
      { artifact_id: metadata.id },
      { scope: "session", ownerId: "session-b" },
    );
    assert.equal(invalid, foreign);
    assert.match(foreign, /not found or is not accessible/);
    assert.doesNotMatch(foreign, /session-a|private result/);
  });

  test("rejects invalid offsets and limits before reading", () => {
    const { readArtifact } = fixture();
    const owner = { scope: "run", ownerId: "run-1" };
    assert.match(readArtifact({ artifact_id: "artifact-1", offset: -1 }, owner), /offset/);
    assert.match(
      readArtifact({
        artifact_id: "artifact-1",
        limit: ARTIFACT_RETRIEVAL_LIMITS.maxChunkBytes + 1,
      }, owner),
      /limit/,
    );
  });
});
