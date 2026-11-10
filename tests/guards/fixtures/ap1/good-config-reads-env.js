// AP1 green: the config registry is the one place allowed to read env.
export function dataDir() {
  return process.env.APERIO_DATA_DIR ?? './var';
}
