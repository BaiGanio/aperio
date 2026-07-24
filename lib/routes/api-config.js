// lib/routes/api-config.js
// Read-only config schema for the Settings UI (issue #167, Phase 2).
//
// GET /api/config/schema returns the registry (lib/config.js) decorated with
// each var's current effective value, so a generic front-end renderer can build
// a typed control per var without hard-coding anything.
//
// Resolution shown matches the resolver, including APERIO_CONFIG_PRECEDENCE:
// "db" (default) → DB > env > default; "env" → env > DB > default, where a value
// present in the real .env file wins. Because the boot resolver already injected
// DB values into process.env, process.env[KEY] is the effective value; we read
// the raw DB setting and the .env file separately only to label the provenance
// (db / env / default) and to decide `configured` for secrets.
//
// Secrets are NEVER returned in plaintext here — only { configured: bool },
// mirroring the write-only masking in api-settings.js. Tier-0 vars are flagged
// editable:false (bootstrap/security plumbing, edited in .env, shown read-only),
// unless a var opts in with `editable: true` (e.g. APERIO_CONFIG_PRECEDENCE).
import { CONFIG, SECTIONS, UI_CATEGORIES } from "../config.js";
import { configSettingKey, sourceFor } from "../config-resolver.js";
import { llamacppCtxStatus } from "../providers/index.js";
import { parseEnvFile, unmanagedFields, shadowedEnvKeys, IMPORTED_SECTION } from "../config-sync.js";
import logger from "../helpers/logger.js";

// Cross-field config problems the per-var rows can't express (issue #182). The
// Settings UI renders these as warning banners so a browser user sees the same
// thing the server logs — the clamp warning is otherwise log-only and invisible.
// #252 adds per-key shadow notices: in db mode, a .env line that lost to a
// differing DB value gets a courtesy warning naming both values (secrets
// masked) and the two remedies. The provenance chips already show the source;
// this is the "why is my .env edit ignored?" answer, not a blocker.
function configWarnings({ fileEnv = {}, settings = {}, envWins = false } = {}) {
  const warnings = [];
  for (const s of shadowedEnvKeys({ fileEnv, settings, envWins })) {
    const values = s.secret
      ? `to a different value than the one saved in Settings; the Settings value wins`
      : `=${s.envValue}, but the value saved in Settings (${s.dbValue}) wins`;
    warnings.push({
      level: "info",
      shadowed: true,
      keys: [s.key],
      message:
        `Your .env sets ${s.key}${values} under db precedence. ` +
        `Delete the stale .env line, or set APERIO_CONFIG_PRECEDENCE=env to make .env win.`,
    });
  }
  if (String(process.env.AI_PROVIDER || "").toLowerCase() === "llamacpp") {
    const ctx = llamacppCtxStatus();
    if (ctx.mismatch) {
      warnings.push({
        level: "warning",
        keys: ["LLAMACPP_CTX", "LLAMACPP_SERVE_CTX"],
        message:
          `LLAMACPP_CTX (${ctx.assumed}) is larger than the server's ` +
          `LLAMACPP_SERVE_CTX (${ctx.real}). Aperio clamps its context math to ` +
          `${ctx.real} to avoid silently truncating prompts. Raise ` +
          `LLAMACPP_SERVE_CTX to match, or lower LLAMACPP_CTX.`,
      });
    }
  }
  return warnings;
}

const isSet = (v) => v != null && String(v).trim() !== "";

export function mountConfigRoutes(router, { store, envPath } = {}) {
  router.get("/config/schema", async (_req, res) => {
    try {
      const settings = await store.getSettings();
      const fileEnv  = parseEnvFile(envPath);   // genuine .env values, for provenance
      const envWins  = String(process.env.APERIO_CONFIG_PRECEDENCE || "db")
        .trim().toLowerCase() === "env";

      const fields = CONFIG.map((e) => {
        const dbRaw   = settings[configSettingKey(e.key)];
        const envVal  = process.env[e.key];     // effective post-resolver value
        const envFile = fileEnv[e.key];          // the var as written in .env

        const base = {
          key:      e.key,
          section:  e.section,
          category: e.category,     // Settings-overlay category id (#252)
          advanced: e.advanced,     // hidden behind Simple↔Advanced toggle (#252)
          type:     e.type,
          tier:     e.tier,
          // Tier-1 is editable; a Tier-0 var may opt in via `editable: true`
          // (e.g. APERIO_CONFIG_PRECEDENCE, the meta-switch UI users can flip).
          editable: e.editable ?? (e.tier === 1),
          secret:   e.type === "secret",
          options:  e.options || null,
          help:     e.help || "",
          example:  e.example ?? "",
          default:  e.default ?? "",
        };

        // envPresent: the var is present in the environment layer.  Two signals:
        //   1. isSet(envFile) — the .env file has a value (the resolver's
        //      pre-injection snapshot covers this, so sourceFor sees it).
        //   2. isSet(envVal) && !isSet(dbRaw) — a shell export with no DB
        //      shadow (when dbRaw IS set, envVal is post-injection noise).
        const envPresent = isSet(envFile) || (isSet(envVal) && !isSet(dbRaw));
        const dbSet      = isSet(dbRaw);
        const source     = sourceFor({ envPresent, dbSet, tier0: e.tier === 0, envWins });

        if (e.type === "secret") {
          // Never echo the value; only whether one is set, and where it came from.
          return { ...base, configured: isSet(dbRaw) || isSet(envVal), source };
        }

        let value;
        if (envWins) {
          // env > DB > default, with the .env file as the "env present" signal.
          if (isSet(envFile))     { value = String(envFile); }
          else if (isSet(dbRaw))  { value = String(dbRaw); }
          else if (isSet(envVal)) { value = String(envVal); }  // shell env
          else                    { value = String(e.default ?? ""); }
        } else {
          value = isSet(dbRaw) ? String(dbRaw) : isSet(envVal) ? String(envVal) : String(e.default ?? "");
        }
        return { ...base, value, source };
      });

      // Phase 2b: surface .env vars with no registry entry as inferred,
      // editable controls in an advanced "Imported" section. A value saved for
      // one lands in config.<KEY> (DB), so overlay DB > env to mirror the
      // managed-field precedence; secrets stay masked.
      const imported = unmanagedFields(parseEnvFile(envPath));
      for (const f of imported) {
        const dbRaw = settings[configSettingKey(f.key)];
        if (f.secret) f.configured = f.configured || isSet(dbRaw);
        else if (isSet(dbRaw)) { f.value = String(dbRaw); f.source = "db"; }
      }
      const sections = imported.length ? [...SECTIONS, IMPORTED_SECTION] : SECTIONS;

      res.json({
        sections,
        categories: UI_CATEGORIES,
        fields: [...fields, ...imported],
        precedence: envWins ? "env" : "db",
        warnings: configWarnings({ fileEnv, settings, envWins }),
      });
    } catch (err) {
      logger.error("GET /api/config/schema error:", err);
      res.status(500).json({ error: err.message });
    }
  });
}
