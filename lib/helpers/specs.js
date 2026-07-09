// specs.js — machine detection for the setup wizard.
// Reports RAM + free disk and recommends a right-sized local model so a
// non-technical user doesn't have to guess which local model their box can run.
import os from "os";
import { statfsSync } from "fs";
import { getRecommendedModel, MODEL_FACTS } from "../providers/index.js";
import { isLite } from "../config.js";

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
  const model = getRecommendedModel();
  const facts = MODEL_FACTS[model] ?? null;
  const sizeGB = facts?.sizeGB ?? null;

  // Only flag a disk problem when we actually know both numbers.
  const enoughDisk = diskGB == null || sizeGB == null ? true : diskGB > sizeGB + 2;

  return {
    ramGB: Math.round(ramGB * 10) / 10,
    diskGB: diskGB == null ? null : Math.round(diskGB * 10) / 10,
    recommendedModel: model,
    // The hf repo[:quant] id the same recommendation resolves to for the
    // llamacpp engine — LLAMACPP_MODEL wants this, not the Ollama-tag key.
    recommendedModelHf: facts?.hf ?? null,
    modelSizeGB: sizeGB,
    enoughDisk,
    // Lite pins its local engine to Ollama until its own vendored-llama.cpp
    // follow-up (llamacpp.md Phase 6) — the wizard needs to know before it
    // decides which provider the "Run locally" screen submits.
    lite: isLite(),
  };
}
