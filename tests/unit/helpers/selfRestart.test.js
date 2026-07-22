// tests/lib/helpers/selfRestart.test.js
import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isSupervised } from "../../../lib/helpers/selfRestart.js";

// Snapshot the env vars isSupervised() reads, so each test starts clean.
const KEYS = ["APERIO_SUPERVISED", "KUBERNETES_SERVICE_HOST", "pm_id", "INVOCATION_ID"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

function clearEnv() {
  for (const k of KEYS) delete process.env[k];
}

afterEach(() => {
  clearEnv();
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
});

describe("isSupervised — explicit override wins", () => {
  test("APERIO_SUPERVISED=1 forces true", () => {
    clearEnv();
    process.env.APERIO_SUPERVISED = "1";
    assert.equal(isSupervised(), true);
  });

  test("APERIO_SUPERVISED=0 forces false even when other signals are present", () => {
    clearEnv();
    process.env.APERIO_SUPERVISED = "0";
    process.env.pm_id = "3";
    process.env.KUBERNETES_SERVICE_HOST = "10.0.0.1";
    assert.equal(isSupervised(), false);
  });
});

describe("isSupervised — auto-detected supervisors", () => {
  test("PM2 (pm_id) → true", () => {
    clearEnv();
    process.env.pm_id = "0";
    assert.equal(isSupervised(), true);
  });

  test("Kubernetes (KUBERNETES_SERVICE_HOST) → true", () => {
    clearEnv();
    process.env.KUBERNETES_SERVICE_HOST = "10.0.0.1";
    assert.equal(isSupervised(), true);
  });

  test("systemd (INVOCATION_ID) → true", () => {
    clearEnv();
    process.env.INVOCATION_ID = "abc123";
    assert.equal(isSupervised(), true);
  });
});
