import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  detectOllamaMigration,
  formatOllamaMigrationMessage,
  checkOllamaMigrationOrExit,
  VAR_MAP,
} from "../../../lib/helpers/ollamaMigrationShim.js";

describe("detectOllamaMigration", () => {
  test("clean llamacpp env needs no migration", () => {
    assert.equal(detectOllamaMigration({ AI_PROVIDER: "llamacpp" }), null);
  });

  test("clean anthropic env needs no migration", () => {
    assert.equal(detectOllamaMigration({ AI_PROVIDER: "anthropic" }), null);
  });

  test("empty env needs no migration", () => {
    assert.equal(detectOllamaMigration({}), null);
  });

  test("AI_PROVIDER=ollama triggers migration", () => {
    const d = detectOllamaMigration({ AI_PROVIDER: "ollama" });
    assert.equal(d.providerIsOllama, true);
    assert.deepEqual(d.ollamaVarsSet, []);
  });

  test("AI_PROVIDER=Ollama is case-insensitive", () => {
    assert.equal(detectOllamaMigration({ AI_PROVIDER: "Ollama" }).providerIsOllama, true);
  });

  test("a lingering OLLAMA_* var triggers migration even on a different provider", () => {
    const d = detectOllamaMigration({ AI_PROVIDER: "anthropic", OLLAMA_MODEL: "qwen2.5:3b" });
    assert.equal(d.providerIsOllama, false);
    assert.deepEqual(d.ollamaVarsSet, ["OLLAMA_MODEL"]);
  });

  test("blank OLLAMA_* vars don't count as set", () => {
    assert.equal(detectOllamaMigration({ AI_PROVIDER: "llamacpp", OLLAMA_MODEL: "" }), null);
  });

  test("collects every set OLLAMA_* var, sorted", () => {
    const d = detectOllamaMigration({
      AI_PROVIDER: "ollama",
      OLLAMA_VLM_MODEL: "qwen2.5vl:3b",
      OLLAMA_BASE_URL: "http://localhost:11434",
    });
    assert.deepEqual(d.ollamaVarsSet, ["OLLAMA_BASE_URL", "OLLAMA_VLM_MODEL"]);
  });
});

describe("formatOllamaMigrationMessage", () => {
  test("includes every VAR_MAP entry", () => {
    const msg = formatOllamaMigrationMessage({ providerIsOllama: true, ollamaVarsSet: [] });
    for (const [oldKey, newKey] of VAR_MAP) {
      assert.ok(msg.includes(oldKey), `missing ${oldKey}`);
      assert.ok(msg.includes(newKey), `missing ${newKey}`);
    }
  });

  test("includes the AI_PROVIDER mapping and re-download notice", () => {
    const msg = formatOllamaMigrationMessage({ providerIsOllama: true, ollamaVarsSet: [] });
    assert.ok(msg.includes("AI_PROVIDER=ollama"));
    assert.ok(msg.includes("AI_PROVIDER=llamacpp"));
    assert.ok(/not reused|NOT reused/i.test(msg));
  });

  test("lists curated model download sizes", () => {
    const msg = formatOllamaMigrationMessage({ providerIsOllama: true, ollamaVarsSet: [] });
    assert.ok(msg.includes("Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M"));
    assert.ok(/~1\.9 GB/.test(msg));
  });

  test("omits the AI_PROVIDER line when only a lingering var triggered it", () => {
    const msg = formatOllamaMigrationMessage({ providerIsOllama: false, ollamaVarsSet: ["OLLAMA_MODEL"] });
    assert.ok(!msg.includes("AI_PROVIDER=ollama is set"));
    assert.ok(msg.includes("Also set: OLLAMA_MODEL"));
  });
});

describe("checkOllamaMigrationOrExit", () => {
  test("returns false and does not exit on a clean env", () => {
    let exited = false;
    const result = checkOllamaMigrationOrExit({ AI_PROVIDER: "llamacpp" }, {
      write: () => {},
      exit: () => { exited = true; },
    });
    assert.equal(result, false);
    assert.equal(exited, false);
  });

  test("writes the message and exits(1) on a dirty env", () => {
    let written = "";
    let exitCode = null;
    const result = checkOllamaMigrationOrExit({ AI_PROVIDER: "ollama" }, {
      write: (s) => { written += s; },
      exit: (code) => { exitCode = code; },
    });
    assert.equal(result, true);
    assert.equal(exitCode, 1);
    assert.ok(written.includes("AI_PROVIDER=llamacpp"));
  });
});
