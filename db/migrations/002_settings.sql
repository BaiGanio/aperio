-- 002_settings.sql
-- Key/value store for user preferences that used to live in env vars or
-- browser localStorage (theme, sound, voice, allowed paths, reasoning toggle…).
-- One row per setting; value is JSONB so we can store strings, booleans,
-- numbers, or small objects without a schema change per preference.

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
