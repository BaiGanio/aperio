// lib/startOllama.js
import { spawn } from "child_process";

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const MAX_WAIT_MS = 15_000;
const POLL_MS     = 500;

async function isOllamaUp() {
  try {
    const r = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(1000) });
    return r.ok;
  } catch { return false; }
}

export async function ensureOllama() {
  if (await isOllamaUp()) {
    console.log("🦙 Ollama already running");
    return;
  }

  console.log("🦙 Starting Ollama in background…");
  const proc = spawn("ollama", ["serve"], {
    detached: true,
    stdio: "ignore",   // fully silent
  });
  proc.unref(); // don't keep Node alive for it

  // Poll until ready or timeout
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_MS));
    if (await isOllamaUp()) {
      console.log("✅ Ollama ready");
      return;
    }
  }
  throw new Error("Ollama did not start within 15 s — is it installed?");
}