-- 012_gemma4_e2b_model_fact.sql — Postgres
-- Add the low-memory Gemma 4 E2B default to the runtime sizing catalog.
-- Mirror of db/migrations-sqlite/012_gemma4_e2b_model_fact.sql — keep in lockstep.

INSERT INTO model_facts
  (alias, hf, size_gb, max_context, kv_bytes_per_token, architecture, active_params, mmproj)
VALUES
  ('gemma4:e2b-qat', 'unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL', 2.62, 131072, 172032, 'dense', NULL, NULL)
ON CONFLICT(alias) DO UPDATE SET
  hf = EXCLUDED.hf,
  size_gb = EXCLUDED.size_gb,
  max_context = EXCLUDED.max_context,
  kv_bytes_per_token = EXCLUDED.kv_bytes_per_token,
  architecture = EXCLUDED.architecture,
  active_params = EXCLUDED.active_params,
  mmproj = EXCLUDED.mmproj;
