// AP1 green: the one Tier-0 bootstrap file is allowed to read env.
export function dataDir() {
  return process.env.APERIO_DATA_DIR ?? './var';
}
