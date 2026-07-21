export const GIB = 1024 ** 3;
export const TIER_POLICY = "RAM <= 8 => 8 GB; RAM <= 16 => 16 GB; RAM <= 24 => 24 GB; RAM > 24 => 32 GB";
export const PREFLIGHT_DISK_RESERVE_GB = 2;
// Keep the pilot funnel explicit and extensible as additional pilot cases are
// approved. The full qualification suite remains available through --case.
export const DEFAULT_PILOT_CASE_IDS = Object.freeze([
  "recall-semantic-nats",
  "recall-filter-type",
  "recall-filter-tag",
  "recall-update-by-id",
  "chain-recall-wiki",
]);
