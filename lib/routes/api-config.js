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
// editable:false (bootstrap/security plumbing, edited in .env, shown read-only).
import { CONFIG, SECTIONS } from "../config.js";
import { configSettingKey } from "../config-resolver.js";
import { parseEnvFile, unmanagedFields, IMPORTED_SECTION } from "../config-sync.js";
import logger from "../helpers/logger.js";

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
          type:     e.type,
          tier:     e.tier,
          editable: e.tier === 1,
          secret:   e.type === "secret",
          options:  e.options || null,
          help:     e.help || "",
          example:  e.example ?? "",
          default:  e.default ?? "",
        };

        if (e.type === "secret") {
          // Never echo the value; only whether one is set, and where it came from.
          const source = envWins
            ? (isSet(envFile) ? "env" : isSet(dbRaw) ? "db" : isSet(envVal) ? "env" : "default")
            : (isSet(dbRaw) ? "db" : isSet(envVal) ? "env" : "default");
          return { ...base, configured: isSet(dbRaw) || isSet(envVal), source };
        }

        let value, source;
        if (envWins) {
          // env > DB > default, with the .env file as the "env present" signal.
          if (isSet(envFile))     { value = String(envFile); source = "env"; }
          else if (isSet(dbRaw))  { value = String(dbRaw);   source = "db"; }
          else if (isSet(envVal)) { value = String(envVal);  source = "env"; }  // shell env
          else                    { value = String(e.default ?? ""); source = "default"; }
        } else {
          value  = isSet(dbRaw) ? String(dbRaw) : isSet(envVal) ? String(envVal) : String(e.default ?? "");
          source = isSet(dbRaw) ? "db" : isSet(envVal) ? "env" : "default";
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
        fields: [...fields, ...imported],
        precedence: envWins ? "env" : "db",
      });
    } catch (err) {
      logger.error("GET /api/config/schema error:", err);
      res.status(500).json({ error: err.message });
    }
  });
}
