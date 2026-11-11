// src/config/registry.js - every configuration key Aperio v2 reads (spec S2.2).
//
// Pure data. Nothing here reads a value. Tier 0 = env only (bootstrap and
// security keys; a DB value is ignored). Tier 1 = the Settings DB may set it.
// Types: int, bool, select, text, path. Defaults are strings, parsed like any
// other layer, so one parser covers all three layers.
//
// A later step adds its own keys here, one test each. Then run `npm run gen:env`.

/**
 * @typedef {object} ConfigEntry
 * @property {string} key
 * @property {0 | 1} tier
 * @property {'int' | 'bool' | 'select' | 'text' | 'path'} type
 * @property {string} default
 * @property {string[]} [options]
 * @property {boolean} [secret]
 * @property {string} help
 */

/** @type {readonly ConfigEntry[]} */
export const REGISTRY = Object.freeze([
  // --- Tier 0: env only -----------------------------------------------------
  { key: 'APERIO_CONFIG_PRECEDENCE', tier: 0, type: 'select', default: 'db', options: ['db', 'env'],
    help: 'Who wins when a key is in both the Settings DB and the environment. db = the Settings DB; env = the environment.' },
  { key: 'PORT', tier: 0, type: 'int', default: '3000', help: 'Port the web app listens on.' },
  { key: 'HOST', tier: 0, type: 'text', default: '127.0.0.1',
    help: 'Interface the web app binds to. 0.0.0.0 exposes it to your network.' },
  { key: 'SQLITE_PATH', tier: 0, type: 'path', default: './.sqlite/aperio.db',
    help: 'Where the SQLite database lives.' },
  { key: 'APERIO_ALLOWED_PATHS', tier: 0, type: 'text', default: '',
    help: 'Comma-separated absolute folders the file tools may read and write. Empty = none.' },
  { key: 'LLAMACPP_VENDOR_DIR', tier: 0, type: 'path', default: 'vendor/llamacpp',
    help: 'Folder that holds the llama-server binary.' },

  // --- Tier 1: Settings DB may set these ------------------------------------
  { key: 'LLAMACPP_MODEL', tier: 1, type: 'text', default: 'unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL',
    help: 'The local model llama-server loads (Hugging Face repo:quant or a path).' },
  { key: 'LLAMACPP_PORT', tier: 1, type: 'int', default: '8080',
    help: 'Port llama-server listens on (127.0.0.1 only).' },
  { key: 'LLAMACPP_SERVE_CTX', tier: 1, type: 'int', default: '32768',
    help: 'Most context llama-server may allocate. The server gets min(this, the model maximum); the token budget uses the n_ctx the server reports.' },
  { key: 'LLAMACPP_THREADS', tier: 1, type: 'int', default: '0',
    help: 'CPU threads for llama-server. 0 = auto: performance cores minus EMBEDDING_THREADS, so the two models do not fight for cores.' },
  { key: 'LLAMACPP_START_TIMEOUT_MS', tier: 1, type: 'int', default: '120000',
    help: 'How long to wait for llama-server to load the model and answer /health, in ms.' },
  { key: 'LLAMA_CACHE', tier: 1, type: 'path', default: '',
    help: 'Model download cache. Empty = the llama.cpp default.' },
  { key: 'EMBEDDING_MODEL', tier: 1, type: 'text', default: 'mixedbread-ai/mxbai-embed-large-v1',
    help: 'Local transformers embedding model. A change flags every memory for re-embedding.' },
  { key: 'EMBEDDING_THREADS', tier: 1, type: 'int', default: '2',
    help: 'CPU threads the embedding model may use. Uncapped it took half the cores and slowed llama.cpp.' },
  { key: 'TRANSFORMERS_CACHE', tier: 1, type: 'path', default: '~/.cache/aperio/transformers',
    help: 'Local cache folder for the embedding model.' },
  { key: 'RECALL_TOP_K', tier: 1, type: 'int', default: '5',
    help: 'How many memories auto-recall puts into a turn, at most.' },
  { key: 'RECALL_TOKEN_BUDGET', tier: 1, type: 'int', default: '1200',
    help: 'Token cap for recalled memories per turn. Step S2.6 sets the measured value.' },
  { key: 'SESSION_RETENTION_DAYS', tier: 1, type: 'int', default: '14',
    help: 'Days of chat history to keep.' },
  { key: 'LOG_LEVEL', tier: 1, type: 'select', default: 'info', options: ['error', 'warn', 'info', 'debug'],
    help: 'How much the app logs.' },
].map((e) => Object.freeze(e)));
