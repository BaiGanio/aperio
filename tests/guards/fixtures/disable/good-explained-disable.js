// Edge case green: the disable names the AP id and gives a reason.
export function timeout() {
  // eslint-disable-next-line no-restricted-properties -- AP1: tier-0 bootstrap, config is not loaded yet
  return Number(process.env.APERIO_TIMEOUT_MS ?? 30000);
}
