// lib/helpers/ollamaMigrationShim.js
//
// llamacpp.md Phase 6: Ollama support was removed from Aperio (this is a dev
// branch — "old functionality may be swapped for new"). A boot with
// AI_PROVIDER=ollama or any OLLAMA_* var still set means the user's .env
// predates the swap. Rather than silently remapping (which would start the
// app against config the user never actually chose), refuse to boot and print
// the exact old→new mapping so they can edit .env themselves and re-run.
import { MODEL_FACTS } from "../providers/index.js";

// Old var → new var. Base-URL/host collapse to one var because llama-server
// has no separate "host" knob the way Ollama's OLLAMA_HOST did.
export const VAR_MAP = [
  ["OLLAMA_MODEL", "LLAMACPP_MODEL"],
  ["OLLAMA_VLM_MODEL", "LLAMACPP_VLM_MODEL"],
  ["OLLAMA_BASE_URL", "LLAMACPP_BASE_URL"],
  ["OLLAMA_HOST", "LLAMACPP_BASE_URL"],
  ["OLLAMA_NUM_CTX", "LLAMACPP_CTX"],
  ["OLLAMA_CONTEXT_LENGTH", "LLAMACPP_SERVE_CTX"],
  ["OLLAMA_FETCH_TIMEOUT_MS", "LLAMACPP_FETCH_TIMEOUT_MS"],
  ["OLLAMA_HEALTH_TIMEOUT_MS", "LLAMACPP_HEALTH_TIMEOUT_MS"],
  ["OLLAMA_VLM_TIMEOUT_MS", "LLAMACPP_VLM_TIMEOUT_MS"],
  ["WIKI_REFRESH_AUTOSTART_OLLAMA", "WIKI_REFRESH_AUTOSTART_LLAMACPP"],
];

// Pure: does this env need the migration screen? Returns null when clean,
// else the evidence (which triggered it) so the formatter can be specific.
export function detectOllamaMigration(env = process.env) {
  const provider = String(env.AI_PROVIDER || "").trim().toLowerCase();
  const providerIsOllama = provider === "ollama";
  const ollamaVarsSet = Object.keys(env)
    .filter(k => k.startsWith("OLLAMA_") && String(env[k] ?? "").trim() !== "")
    .sort();
  if (!providerIsOllama && ollamaVarsSet.length === 0) return null;
  return { providerIsOllama, ollamaVarsSet };
}

// Curated model list with real download sizes, deduped by hf id (MODEL_FACTS
// has a couple of case-variant duplicate keys for lookup convenience).
function curatedModelLines() {
  const seen = new Set();
  const lines = [];
  for (const [tag, facts] of Object.entries(MODEL_FACTS)) {
    if (!facts.hf || seen.has(facts.hf)) continue;
    seen.add(facts.hf);
    lines.push(`    ${tag.padEnd(16)} → ${facts.hf}  (~${facts.sizeGB} GB)`);
  }
  return lines;
}

// Pure: build the one-screen message. No I/O.
export function formatOllamaMigrationMessage(detection) {
  const lines = [];
  lines.push("");
  lines.push("=".repeat(78));
  lines.push("  Aperio no longer uses Ollama — it now vendors and manages llama.cpp");
  lines.push("  directly. Your .env still points at Ollama; Aperio refuses to guess a");
  lines.push("  replacement config, so nothing was silently remapped.");
  lines.push("=".repeat(78));
  lines.push("");
  if (detection.providerIsOllama) lines.push('  AI_PROVIDER=ollama is set — this value no longer exists.');
  if (detection.ollamaVarsSet.length) {
    lines.push(`  Also set: ${detection.ollamaVarsSet.join(", ")}`);
  }
  lines.push("");
  lines.push("  Edit your .env by hand:");
  lines.push("");
  lines.push("    AI_PROVIDER=ollama         → AI_PROVIDER=llamacpp");
  for (const [oldKey, newKey] of VAR_MAP) {
    lines.push(`    ${oldKey.padEnd(26)} → ${newKey}`);
  }
  lines.push("");
  lines.push("  Ollama's model blobs are NOT reused — llama.cpp downloads its own GGUF");
  lines.push("  files (LLAMA_CACHE, default ./var/models). Budget the download again:");
  lines.push("");
  lines.push(...curatedModelLines());
  lines.push("");
  lines.push("  OLLAMA_MODEL used an Ollama tag (e.g. \"qwen2.5:3b\"); LLAMACPP_MODEL wants");
  lines.push("  the Hugging Face repo[:quant] string from the table above instead.");
  lines.push("");
  lines.push("  Once .env is updated, re-run this command.");
  lines.push("=".repeat(78));
  lines.push("");
  return lines.join("\n");
}

/**
 * Boot-time gate. Returns true (and exits, unless `exit` is stubbed for tests)
 * when the env needs migrating; false when the env is clean and boot should
 * continue normally.
 */
export function checkOllamaMigrationOrExit(env = process.env, { write = (s) => process.stderr.write(s), exit = process.exit } = {}) {
  const detection = detectOllamaMigration(env);
  if (!detection) return false;
  write(formatOllamaMigrationMessage(detection) + "\n");
  exit(1);
  return true;
}
