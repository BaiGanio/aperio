// Edge case: a disable comment that names no AP id and gives no reason.
/* eslint-disable no-restricted-properties */
export function timeout() {
  return Number(process.env.APERIO_TIMEOUT_MS ?? 30000);
}
