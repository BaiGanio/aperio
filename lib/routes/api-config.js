// lib/routes/api-config.js
// Read-only config schema for the Settings UI (issue #167, Phase 2).
//
// GET /api/config/schema returns the registry (lib/config.js) decorated with
// each var's current effective value, so a generic front-end renderer can build
// a typed control per var without hard-coding anything.
//
// Resolution shown matches the resolver (DB > env > default). Because the boot
// resolver already injected DB values into process.env, process.env[KEY] is the
// effective value; we read the raw DB setting separately only to label the
// provenance (db / env / default) and to decide `configured` for secrets.
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

      const fields = CONFIG.map((e) => {
        const dbRaw  = settings[configSettingKey(e.key)];
        const envVal = process.env[e.key];

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
          // Never echo the value; only whether one is set (DB or env).
          return { ...base, configured: isSet(dbRaw) || isSet(envVal) };
        }

        const value  = isSet(dbRaw) ? String(dbRaw)
                      : isSet(envVal) ? String(envVal)
                      : String(e.default ?? "");
        const source = isSet(dbRaw) ? "db" : isSet(envVal) ? "env" : "default";
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

      res.json({ sections, fields: [...fields, ...imported] });
    } catch (err) {
      logger.error("GET /api/config/schema error:", err);
      res.status(500).json({ error: err.message });
    }
  });
}
