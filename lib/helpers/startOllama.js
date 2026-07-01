// lib/startOllama.js
import { spawn } from "child_process";
import logger from "./logger.js";
import { recommendServeContextLength } from "../providers/index.js";

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
  // Ollama's serving context window — the KV-cache size, and the thing that
  // decides whether a model fits in VRAM or spills to CPU and crawls — is set by
  // the server's OLLAMA_CONTEXT_LENGTH, NOT by anything the app sends over the
  // /v1 chat API. So when WE start the server, pick a window the selected model
  // can actually hold in RAM (recommendServeContextLength) and push it on. An
  // explicit OLLAMA_CONTEXT_LENGTH / OLLAMA_NUM_CTX the user set always wins.
  //
  // Because Aperio owns Ollama's lifecycle, compute the window ONCE and publish
  // both vars to our OWN env so every downstream reader stays consistent:
  //   • the server gets the full window as its KV-cache size (OLLAMA_CONTEXT_LENGTH)
  //   • the app's trim/cap math (OLLAMA_NUM_CTX) gets ~92% of it — num_ctx is
  //     prompt+output shared, so filling it 100% with prompt leaves the model no
  //     room to answer. Reserve at least 512 tokens for generation at small
  //     windows (where a flat percentage would be too tight to answer at all).
  // The compute sits ABOVE the "already running" early-return: when Aperio
  // spawned Ollama on a prior boot and is now restarting against it, we don't
  // respawn but still must set OLLAMA_NUM_CTX for the trim math.
  const serveCtx = recommendServeContextLength();
  if (!process.env.OLLAMA_CONTEXT_LENGTH) process.env.OLLAMA_CONTEXT_LENGTH = serveCtx;
  if (!process.env.OLLAMA_NUM_CTX) {
    const n = parseInt(serveCtx, 10);
    process.env.OLLAMA_NUM_CTX = String(Math.max(1, Math.min(Math.floor(n * 0.92), n - 512)));
  }

  if (await isOllamaUp()) {
    logger.info("🦙 Ollama already running");
    return;
  }

  logger.info(`🦙 Starting Ollama in background… (OLLAMA_CONTEXT_LENGTH=${process.env.OLLAMA_CONTEXT_LENGTH}, OLLAMA_NUM_CTX=${process.env.OLLAMA_NUM_CTX})`);
  const proc = spawn("ollama", ["serve"], {
    detached: true,
    stdio: "ignore",   // fully silent
    env: { ...process.env, OLLAMA_CONTEXT_LENGTH: process.env.OLLAMA_CONTEXT_LENGTH },
  });
  proc.on("error", () => {}); // suppress ENOENT / other spawn errors; poll will time out naturally
  proc.unref(); // don't keep Node alive for it

  // Poll until ready or timeout
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_MS));
    if (await isOllamaUp()) {
      logger.info("✅ Ollama ready");
      return;
    }
  }
  throw new Error("Ollama did not start within 15 s — is it installed?");
}