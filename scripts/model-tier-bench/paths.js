import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives one directory below the repo-root-relative script
// (scripts/model-tier-bench/paths.js), so ROOT climbs two levels.
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_MODELS = join(ROOT, ".github/model-tiers/models.json");
export const DEFAULT_CASES = join(ROOT, ".github/model-tiers/cases.json");
export const DEFAULT_FULL_EXAM = join(ROOT, ".github/model-tiers/full-exam.json");
export const FIXTURE = join(ROOT, ".github/capability-exam/exam.memories.json");
export const FIXTURE_CONTRACT = join(ROOT, ".github/model-tiers/fixture-contract.json");
export const WORKSPACE_FIXTURE = join(ROOT, ".github/model-tiers/workspace");
