// specs.js — machine detection for the setup wizard.
// Reports RAM + free disk and recommends a right-sized local model so a
// non-technical user doesn't have to guess which local model their box can run.
import os from "os";
import { statfsSync } from "fs";
import { getRecommendedModel, factsForHf, modelDisplayName, resolvePerfProfile } from "../providers/index.js";
import { detectHardware } from "./hardware.js";

function freeDiskGB(path = process.cwd()) {
  try {
    const { bavail, bsize } = statfsSync(path);
    return (bavail * bsize) / 1024 ** 3;
  } catch {
    return null; // statfs unsupported / path gone — caller treats as "unknown"
  }
}

export function getSpecs() {
  const ramGB = os.totalmem() / 1024 ** 3;
  const diskGB = freeDiskGB();
  const profile = resolvePerfProfile();
  const hardware = detectHardware();
  const model = getRecommendedModel(profile, hardware);
  const facts = factsForHf(model);
  const sizeGB = facts?.sizeGB ?? null;

  // Only flag a disk problem when we actually know both numbers.
  const enoughDisk = diskGB == null || sizeGB == null ? true : diskGB > sizeGB + 2;

  return {
    ramGB: Math.round(ramGB * 10) / 10,
    diskGB: diskGB == null ? null : Math.round(diskGB * 10) / 10,
    recommendedModel: modelDisplayName(model),
    // The hf repo[:quant] id the same recommendation resolves to for the
    // llamacpp engine — LLAMACPP_MODEL wants this, not the MODEL_FACTS key.
    recommendedModelHf: model,
    modelSizeGB: sizeGB,
    enoughDisk,
    // Perf profile (llamacpp.md Phase 4) + best-effort VRAM readout — surfaced
    // for the wizard/Settings UI, not used in the disk-space math above.
    perfProfile: profile,
    vramGB: hardware.vramGB == null ? null : Math.round(hardware.vramGB * 10) / 10,
    vramSource: hardware.vramSource,
  };
}
