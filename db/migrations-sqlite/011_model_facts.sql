-- 011_model_facts.sql — SQLite
-- Curated llama.cpp sizing metadata, replacing the source-code MODEL_FACTS map.
-- Mirror of db/migrations/011_model_facts.sql — keep in lockstep.

CREATE TABLE model_facts (
  alias              TEXT PRIMARY KEY,
  hf                 TEXT NOT NULL,
  size_gb            REAL NOT NULL CHECK (size_gb > 0),
  max_context        INTEGER NOT NULL CHECK (max_context > 0),
  kv_bytes_per_token INTEGER NOT NULL CHECK (kv_bytes_per_token > 0),
  architecture       TEXT NOT NULL CHECK (architecture IN ('dense', 'moe')),
  active_params      REAL,
  mmproj             TEXT
);

CREATE INDEX idx_model_facts_hf ON model_facts(hf);

INSERT INTO model_facts
  (alias, hf, size_gb, max_context, kv_bytes_per_token, architecture, active_params, mmproj)
VALUES
  ('gemma4:e4b-qat', 'unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL', 3.9, 131072, 172032, 'dense', NULL, NULL),
  ('qwen3.5:9b', 'unsloth/Qwen3.5-9B-GGUF:Q4_K_M', 5.3, 262144, 32768, 'dense', NULL, NULL),
  ('qwen3.6:35b-a3b-mtp', 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL', 21.3, 262144, 22528, 'moe', 3, NULL),
  ('gemma4:26b-a4b', 'unsloth/gemma-4-26B-A4B-it-GGUF:UD-Q4_K_XL', 15.8, 262144, 49152, 'moe', 4, NULL),
  ('qwen2.5vl:7b', 'ggml-org/Qwen2.5-VL-7B-Instruct-GGUF', 6, 32768, 172032, 'dense', NULL, NULL)
ON CONFLICT(alias) DO NOTHING;
