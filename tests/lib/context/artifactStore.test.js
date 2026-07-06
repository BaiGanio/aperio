import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createArtifactStore } from "../../../lib/context/artifactStore.js";

const roots = [];

function fixture(overrides = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), "aperio-artifacts-"));
  roots.push(rootDir);
  let nextId = 0;
  const store = createArtifactStore({
    rootDir,
    idFactory: () => `artifact-${++nextId}`,
    now: () => new Date("2026-07-06T12:00:00.000Z"),
    ...overrides,
  });
  return { rootDir, store };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const mode = path => statSync(path).mode & 0o777;

describe("artifact store", () => {
  test("stores immutable content with complete metadata and a stable digest", () => {
    const { rootDir, store } = fixture();
    const content = "complete tool output\nwith unicode: Здравей";

    const metadata = store.put({
      scope: "session",
      ownerId: "session-1",
      sourceTool: "run_shell",
      content,
    });

    assert.deepEqual(metadata, {
      version: 1,
      id: "artifact-1",
      scope: "session",
      ownerId: "session-1",
      sha256: createHash("sha256").update(Buffer.from(content)).digest("hex"),
      byteCount: Buffer.byteLength(content),
      mediaType: "text/plain; charset=utf-8",
      sourceTool: "run_shell",
      createdAt: "2026-07-06T12:00:00.000Z",
    });
    assert.equal(Object.isFrozen(metadata), true);

    const stored = store.read({
      scope: "session",
      ownerId: "session-1",
      artifactId: metadata.id,
    });
    assert.deepEqual(stored.metadata, metadata);
    assert.equal(stored.content.toString("utf8"), content);

    const ownerDir = join(rootDir, "sessions", "session-1");
    assert.equal(mode(rootDir), 0o700);
    assert.equal(mode(join(rootDir, "sessions")), 0o700);
    assert.equal(mode(ownerDir), 0o700);
    assert.equal(mode(join(ownerDir, "artifact-1.bin")), 0o600);
    assert.equal(mode(join(ownerDir, "artifact-1.json")), 0o600);
    assert.deepEqual(
      readdirSync(ownerDir).filter(name => name.endsWith(".tmp")),
      [],
      "atomic writes must not leave temporary files",
    );
  });

  test("stores binary data and respects explicit media types", () => {
    const { store } = fixture();
    const bytes = new Uint8Array([0, 1, 2, 254, 255]);
    const metadata = store.put({
      scope: "run",
      ownerId: "run-42",
      sourceTool: "read_image",
      mediaType: "application/octet-stream",
      content: bytes,
    });

    const stored = store.read({
      scope: "run",
      ownerId: "run-42",
      artifactId: metadata.id,
    });
    assert.deepEqual(stored.content, Buffer.from(bytes));
    assert.equal(stored.metadata.mediaType, "application/octet-stream");
  });

  test("isolates session and run owners", () => {
    const { store } = fixture();
    const sessionArtifact = store.put({
      scope: "session",
      ownerId: "shared-name",
      sourceTool: "fetch_url",
      content: "session value",
    });
    const runArtifact = store.put({
      scope: "run",
      ownerId: "shared-name",
      sourceTool: "fetch_url",
      content: "run value",
    });

    assert.deepEqual(store.listIds({ scope: "session", ownerId: "shared-name" }), [sessionArtifact.id]);
    assert.deepEqual(store.listIds({ scope: "run", ownerId: "shared-name" }), [runArtifact.id]);
    assert.equal(store.read({
      scope: "session",
      ownerId: "other-owner",
      artifactId: sessionArtifact.id,
    }), null);
  });

  test("rejects traversal and unsupported scopes before touching disk", () => {
    const { rootDir, store } = fixture();
    const invalid = [
      { scope: "session", ownerId: "../outside" },
      { scope: "session", ownerId: "/absolute" },
      { scope: "unknown", ownerId: "owner" },
    ];

    for (const input of invalid) {
      assert.throws(() => store.put({
        ...input,
        sourceTool: "run_shell",
        content: "secret",
      }), /safe non-empty identifier|scope must be one of/);
    }
    assert.deepEqual(readdirSync(rootDir), []);
    assert.throws(() => store.getMetadata({
      scope: "session",
      ownerId: "owner",
      artifactId: "../../escape",
    }), /safe non-empty identifier/);
    assert.throws(() => store.put({
      scope: "session",
      ownerId: "owner",
      sourceTool: "run_shell\nforged-log-line",
      content: "secret",
    }), /sourceTool must be/);
    assert.throws(
      () => createArtifactStore({ rootDir: "" }),
      /rootDir must be a non-empty path/,
    );
  });

  test("refuses an ID collision without changing the original artifact", () => {
    const { store } = fixture({ idFactory: () => "fixed-id" });
    const input = {
      scope: "session",
      ownerId: "session-1",
      sourceTool: "run_shell",
    };
    store.put({ ...input, content: "original" });

    assert.throws(
      () => store.put({ ...input, content: "replacement" }),
      /already exists and is immutable/,
    );
    assert.equal(store.read({ ...input, artifactId: "fixed-id" }).content.toString(), "original");
  });

  test("detects content corruption by default", () => {
    const { rootDir, store } = fixture();
    const metadata = store.put({
      scope: "session",
      ownerId: "session-1",
      sourceTool: "run_shell",
      content: "trusted bytes",
    });
    const dataPath = join(rootDir, "sessions", "session-1", `${metadata.id}.bin`);
    writeFileSync(dataPath, "changed bytes");

    assert.throws(
      () => store.read({ scope: "session", ownerId: "session-1", artifactId: metadata.id }),
      /failed integrity verification/,
    );
    assert.equal(
      store.read({
        scope: "session",
        ownerId: "session-1",
        artifactId: metadata.id,
        verify: false,
      }).content.toString(),
      "changed bytes",
    );
  });

  test("rejects corrupt or owner-mismatched metadata", () => {
    const { rootDir, store } = fixture();
    const metadata = store.put({
      scope: "run",
      ownerId: "run-1",
      sourceTool: "web_search",
      content: "result",
    });
    const metadataPath = join(rootDir, "runs", "run-1", `${metadata.id}.json`);

    writeFileSync(metadataPath, "{bad json");
    assert.throws(
      () => store.getMetadata({ scope: "run", ownerId: "run-1", artifactId: metadata.id }),
      /metadata is corrupt/,
    );

    writeFileSync(metadataPath, JSON.stringify({ ...metadata, ownerId: "run-2" }));
    assert.throws(
      () => store.getMetadata({ scope: "run", ownerId: "run-1", artifactId: metadata.id }),
      /does not match its owner/,
    );
  });

  test("removes one owner without deleting another owner's artifacts", () => {
    const { rootDir, store } = fixture();
    store.put({
      scope: "session",
      ownerId: "remove-me",
      sourceTool: "run_shell",
      content: "old",
    });
    const retained = store.put({
      scope: "session",
      ownerId: "keep-me",
      sourceTool: "run_shell",
      content: "current",
    });

    assert.equal(store.removeOwner({ scope: "session", ownerId: "remove-me" }), true);
    assert.equal(store.removeOwner({ scope: "session", ownerId: "remove-me" }), false);
    assert.equal(existsSync(join(rootDir, "sessions", "remove-me")), false);
    assert.equal(
      store.read({
        scope: "session",
        ownerId: "keep-me",
        artifactId: retained.id,
      }).content.toString(),
      "current",
    );
  });

  test("hardens an existing owner directory before writing", () => {
    const { rootDir, store } = fixture();
    const ownerDir = join(rootDir, "sessions", "session-1");
    // Build the path through the same public operation, then loosen it to model
    // a directory left by an older release.
    store.put({
      scope: "session",
      ownerId: "session-1",
      sourceTool: "run_shell",
      content: "first",
    });
    chmodSync(ownerDir, 0o755);

    store.put({
      scope: "session",
      ownerId: "session-1",
      sourceTool: "run_shell",
      content: "second",
    });
    assert.equal(mode(ownerDir), 0o700);
  });
});
