// specs.js — machine detection for the setup wizard.
// Reports RAM + free disk and recommends a right-sized local model so a
// non-technical user doesn't have to guess which Ollama model their box can run.
import os from "os";
import { statfsSync } from "fs";
import { getRecommendedModel } from "../providers/index.js";

// Approximate on-disk download size (GB) per model getRecommendedModel() emits.
// Used only to warn the user before a multi-GB pull — rounded, not exact.
const MODEL_SIZE_GB = {
  "deepseek-r1:32": 20,
  "qwen3:14b": 9,
  "llama3.1:8b": 4.7,
  "qwen2.5:3b": 2,
  "qwen3:8b": 5,
};

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
  const sizeGB = MODEL_SIZE_GB[model] ?? null;

  // Only flag a disk problem when we actually know both numbers.
  const enoughDisk = diskGB == null || sizeGB == null ? true : diskGB > sizeGB + 2;

  return {
    ramGB: Math.round(ramGB * 10) / 10,
    diskGB: diskGB == null ? null : Math.round(diskGB * 10) / 10,
    recommendedModel: model,
    modelSizeGB: sizeGB,
    enoughDisk,
  };
}
