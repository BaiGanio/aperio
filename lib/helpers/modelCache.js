// lib/helpers/modelCache.js
//
// Resolve the on-disk directory llama-server downloads GGUF weights into.
//
// Aperio used to force this to a project-local ./var/models, so llama-server
// re-downloaded every model *into the repo* even when the user already had it
// in the standard Hugging Face hub cache — where `llama-cli -cl` and every
// other HF tool look, and where `-hf` pulls land by default. The result was a
// full duplicate hoard inside the app folder. We now default to that shared HF
// hub cache so models are reused, never duplicated, and never stored in-repo.
//
// Resolution order (first hit wins), matching huggingface_hub's own:
//   1. LLAMA_CACHE               — explicit override (llama.cpp's own env var)
//   2. HF_HUB_CACHE              — HF hub cache override
//   3. $HF_HOME/hub             — HF home override
//   4. ~/.cache/huggingface/hub — the huggingface_hub default
import { homedir } from "os";
import { join } from "path";

/**
 * Directory llama-server should use as its GGUF cache root. Reads the given
 * env (default process.env) so callers can resolve at spawn time. Never returns
 * a project-local path unless the user explicitly set LLAMA_CACHE to one.
 */
export function resolveModelCacheDir(env = process.env) {
  if (env.LLAMA_CACHE)  return env.LLAMA_CACHE;
  if (env.HF_HUB_CACHE) return env.HF_HUB_CACHE;
  if (env.HF_HOME)      return join(env.HF_HOME, "hub");
  return join(homedir(), ".cache", "huggingface", "hub");
}
