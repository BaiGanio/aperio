// lib/helpers/llamacpp/constants.js — shared paths/timeouts for the llama.cpp lifecycle modules.

export const LLAMACPP_PORT     = process.env.LLAMACPP_PORT || "8080";
export const LLAMACPP_BASE_URL = process.env.LLAMACPP_BASE_URL ?? `http://127.0.0.1:${LLAMACPP_PORT}`;
export const MAX_WAIT_MS       = 30_000; // GGUF weight-loading can outrun Ollama's 15 s
export const KILL_TIMEOUT_MS   = 5_000;
export const STATE_FILE        = "./var/llamacpp/state.json";
export const POLL_MS           = 500;
export const PRESET_DIR        = "./var/llamacpp";
export const PRESET_PATH       = `${PRESET_DIR}/models.ini`;
export const SERVER_LOG_PATH   = `${PRESET_DIR}/server.log`;
