// AP1 violation: ordinary app code reading process.env directly.
export function timeout() {
  return Number(process.env.APERIO_TIMEOUT_MS ?? 30000);
}
