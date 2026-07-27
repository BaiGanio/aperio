import { getModelFactsCatalog, installModelFacts } from "../../lib/providers/model-facts.js";

export const CURATED_MODEL_FACT_ROWS = [
  { alias: "gemma4:e4b-qat", hf: "unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL", sizeGB: 3.9, maxContext: 131072, kvBytesPerToken: 172032, architecture: "dense", activeParams: null, mmproj: null },
  { alias: "qwen3.5:9b", hf: "unsloth/Qwen3.5-9B-GGUF:Q4_K_M", sizeGB: 5.3, maxContext: 262144, kvBytesPerToken: 32768, architecture: "dense", activeParams: null, mmproj: null },
  { alias: "qwen3.6:35b-a3b-mtp", hf: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL", sizeGB: 21.3, maxContext: 262144, kvBytesPerToken: 22528, architecture: "moe", activeParams: 3, mmproj: null },
  { alias: "gemma4:26b-a4b", hf: "unsloth/gemma-4-26B-A4B-it-GGUF:UD-Q4_K_XL", sizeGB: 15.8, maxContext: 262144, kvBytesPerToken: 49152, architecture: "moe", activeParams: 4, mmproj: null },
  { alias: "qwen2.5vl:7b", hf: "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF", sizeGB: 6, maxContext: 32768, kvBytesPerToken: 172032, architecture: "dense", activeParams: null, mmproj: null },
];

export function installCuratedModelFacts() {
  installModelFacts(CURATED_MODEL_FACT_ROWS);
  return getModelFactsCatalog();
}
