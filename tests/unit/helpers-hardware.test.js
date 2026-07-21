// tests/lib/helpers/hardware.test.js
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { detectHardware } from "../../lib/helpers/hardware.js";

describe("detectHardware", () => {
  test("macOS: VRAM reported as unified with total RAM", () => {
    const hw = detectHardware({ platform: "darwin", totalRamGB: 32 });
    assert.equal(hw.totalRamGB, 32);
    assert.equal(hw.vramGB, 32);
    assert.equal(hw.vramSource, "unified");
  });

  test("Linux/Windows with nvidia-smi available: parses memory.total (MiB) into GB", () => {
    const fakeExec = () => Buffer.from("24576\n");
    const hw = detectHardware({ platform: "linux", totalRamGB: 64, _execFileSync: fakeExec });
    assert.equal(hw.totalRamGB, 64);
    assert.equal(hw.vramGB, 24);
    assert.equal(hw.vramSource, "nvidia-smi");
  });

  test("nvidia-smi output with multiple GPU lines: uses the first line", () => {
    const fakeExec = () => Buffer.from("8192\n8192\n");
    const hw = detectHardware({ platform: "linux", totalRamGB: 16, _execFileSync: fakeExec });
    assert.equal(hw.vramGB, 8);
  });

  test("nvidia-smi not installed / no NVIDIA GPU: falls back to unknown", () => {
    const fakeExec = () => { throw new Error("ENOENT: nvidia-smi not found"); };
    const hw = detectHardware({ platform: "linux", totalRamGB: 16, _execFileSync: fakeExec });
    assert.equal(hw.vramGB, null);
    assert.equal(hw.vramSource, "unknown");
  });

  test("nvidia-smi returns garbage output: falls back to unknown rather than a bogus number", () => {
    const fakeExec = () => Buffer.from("N/A\n");
    const hw = detectHardware({ platform: "win32", totalRamGB: 16, _execFileSync: fakeExec });
    assert.equal(hw.vramGB, null);
    assert.equal(hw.vramSource, "unknown");
  });

  test("windows without nvidia-smi: unknown, not unified (only macOS gets that treatment)", () => {
    const fakeExec = () => { throw new Error("not found"); };
    const hw = detectHardware({ platform: "win32", totalRamGB: 16, _execFileSync: fakeExec });
    assert.equal(hw.vramSource, "unknown");
  });

  test("defaults totalRamGB from the real host when omitted", () => {
    const hw = detectHardware({ platform: "darwin" });
    assert.ok(hw.totalRamGB > 0);
  });
});
