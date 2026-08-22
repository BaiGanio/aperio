-- 012_gemma4_e2b_model_fact.sql — SQLite
-- Add the low-memory Gemma 4 E2B default to the runtime sizing catalog.
-- Mirror of db/migrations/012_gemma4_e2b_model_fact.sql — keep in lockstep.

INSERT INTO model_facts
  (alias, hf, size_gb, max_context, kv_bytes_per_token, architecture, active_params, mmproj)
VALUES
  ('gemma4:e2b-qat', 'unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL', 2.62, 131072, 172032, 'dense', NULL, NULL)
ON CONFLICT(alias) DO UPDATE SET
  hf = excluded.hf,
  size_gb = excluded.size_gb,
  max_context = excluded.max_context,
  kv_bytes_per_token = excluded.kv_bytes_per_token,
  architecture = excluded.architecture,
  active_params = excluded.active_params,
  mmproj = excluded.mmproj;
