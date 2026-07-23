import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives one directory below the repo-root-relative script
// (scripts/model-tier-bench/paths.js), so ROOT climbs two levels.
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_MODELS = join(ROOT, "docs/benchmarks/tools/models.json");
export const DEFAULT_CASES = join(ROOT, "docs/benchmarks/tools/cases.json");
export const DEFAULT_FULL_EXAM = join(ROOT, "docs/benchmarks/tools/full-exam.json");
export const FIXTURE = join(ROOT, ".github/capability-exam/exam.memories.json");
export const FIXTURE_CONTRACT = join(ROOT, "docs/benchmarks/tools/fixture-contract.json");
export const WORKSPACE_FIXTURE = join(ROOT, "docs/benchmarks/tools/workspace");
