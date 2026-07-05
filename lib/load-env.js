// lib/load-env.js — side-effecting: loads .env into process.env at import time.
//
// Import this FIRST in an entry point, before any module that reads
// `process.env` at load time (e.g. db/sqlite.js reads SQLITE_PATH / EMBEDDING_DIMS
// when its module body evaluates). Because ES module imports are hoisted and
// evaluated in source order, importing this module ahead of those guarantees the
// environment is populated before they run.
//
// Only a real `.env` is loaded — `.env.example` holds placeholder/default
// secrets (e.g. POSTGRES_PASSWORD=aperio_secret) and must never be treated as
// live config (same rule as server.js). With no `.env`, shell env + DB-stored
// settings + in-code defaults apply.
import dotenv from "dotenv";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(ROOT, ".env");

if (existsSync(envPath)) dotenv.config({ path: envPath });
