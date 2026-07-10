// Best-effort hardware detection for local-provider sizing (llamacpp.md
// Phase 4). Total RAM is always known (os.totalmem()); VRAM is a best-effort
// probe used only for reporting today — model/context sizing still keys off
// RAM (see getRecommendedModel/recommendContextLength in lib/providers/index.js),
// so a wrong or missing VRAM read never breaks a sizing decision, only a
// diagnostic readout.
import os from "os";
import { execFileSync } from "child_process";

const GIB = 1024 ** 3;

// `_execFileSync` injectable so tests never actually shell out to nvidia-smi.
// execFileSync (not execSync) — no shell, fixed argv, nothing user-controlled.
function probeNvidiaSmiVramGB(_execFileSync = execFileSync) {
  try {
    const out = _execFileSync(
      "nvidia-smi",
      ["--query-gpu=memory.total", "--format=csv,noheader,nounits"],
      { timeout: 3000, stdio: ["ignore", "pipe", "ignore"] },
    ).toString().trim();
    const mb = parseFloat(out.split("\n")[0]);
    return Number.isFinite(mb) && mb > 0 ? mb / 1024 : null;
  } catch {
    return null; // not installed, no NVIDIA GPU, or timed out — all equally "unknown"
  }
}

// { totalRamGB, vramGB, vramSource } — vramSource is one of:
//   "unified" — macOS: Metal shares the RAM pool, so VRAM ≈ total RAM.
//   "nvidia-smi" — parsed from a real nvidia-smi query.
//   "unknown" — no reliable read; callers must treat this as the conservative
//     case (same posture as a confirmed-low-VRAM machine), never assume
//     headroom that isn't there.
// All inputs are injectable/overridable so this unit-tests deterministically
// without touching the real OS or shelling out.
export function detectHardware({
  platform = os.platform(),
  totalRamGB = os.totalmem() / GIB,
  _execFileSync = execFileSync,
} = {}) {
  if (platform === "darwin") {
    return { totalRamGB, vramGB: totalRamGB, vramSource: "unified" };
  }
  const nvidiaVramGB = probeNvidiaSmiVramGB(_execFileSync);
  if (nvidiaVramGB != null) {
    return { totalRamGB, vramGB: nvidiaVramGB, vramSource: "nvidia-smi" };
  }
  return { totalRamGB, vramGB: null, vramSource: "unknown" };
}
