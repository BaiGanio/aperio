import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  ensureLlamaCppVendorOnPath,
  llamaCppBinaryName,
  resolveLlamaCppCommand,
  resolveLlamaCppVendorDir,
} from "../../../lib/helpers/llamacppBinary.js";

describe("llama.cpp vendored binary resolution", () => {
  test("uses the configured persistent vendor directory when its binary exists", () => {
    const env = { LLAMACPP_VENDOR_DIR: "/app/var/llamacpp", PATH: "/usr/bin" };
    const command = resolveLlamaCppCommand({
      env,
      cwd: "/app",
      platform: "linux",
      exists: path => path === "/app/var/llamacpp/llama-server",
    });
    assert.equal(command, "/app/var/llamacpp/llama-server");
  });

  test("falls back to PATH when no private binary exists", () => {
    assert.equal(resolveLlamaCppCommand({
      env: {},
      cwd: "/app",
      platform: "linux",
      exists: () => false,
    }), "llama-server");
  });

  test("prepends the private directory once", () => {
    const env = { LLAMACPP_VENDOR_DIR: "/app/var/llamacpp", PATH: "/usr/bin" };
    const options = {
      env,
      cwd: "/app",
      platform: "linux",
      exists: path => path === "/app/var/llamacpp/llama-server",
    };
    assert.equal(ensureLlamaCppVendorOnPath(options), true);
    assert.equal(ensureLlamaCppVendorOnPath(options), true);
    assert.equal(env.PATH, "/app/var/llamacpp:/usr/bin");
  });

  test("keeps platform-specific names and resolves the normal local default", () => {
    assert.equal(llamaCppBinaryName("win32"), "llama-server.exe");
    assert.equal(resolveLlamaCppVendorDir({}, "/app"), "/app/vendor/llamacpp");
  });
});
