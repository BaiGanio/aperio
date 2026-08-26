// lib/helpers/llamacpp/constants.js — shared paths/timeouts for the llama.cpp lifecycle modules.

export const LLAMACPP_PORT     = process.env.LLAMACPP_PORT || "8080";
export const LLAMACPP_BASE_URL = process.env.LLAMACPP_BASE_URL ?? `http://127.0.0.1:${LLAMACPP_PORT}`;
export const MAX_WAIT_MS       = 30_000; // GGUF weight-loading can outrun Ollama's 15 s
export const KILL_TIMEOUT_MS   = 5_000;
export const POLL_MS           = 500;
// APERIO_LLAMACPP_RUNTIME_DIR lets a caller (the test suite, primarily) point
// the whole preset/state/log lifecycle at a private root instead of the
// shared "./var/llamacpp" every real Aperio process reads and writes. Read at
// module-load time — set it in the environment BEFORE importing this module
// or any of its consumers, never after.
export const PRESET_DIR        = process.env.APERIO_LLAMACPP_RUNTIME_DIR || "./var/llamacpp";
// Port-specific state file so two Aperio processes with different
// LLAMACPP_PORT values never share (and potentially reap) each other's
// llama-server state — each port owns its own record.
export const STATE_FILE        = `${PRESET_DIR}/state-${LLAMACPP_PORT}.json`;
export const PRESET_PATH       = `${PRESET_DIR}/models.ini`;
export const SERVER_LOG_PATH   = `${PRESET_DIR}/server.log`;
