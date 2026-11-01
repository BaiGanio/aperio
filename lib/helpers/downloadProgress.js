// Normalize the human-oriented progress lines emitted by download tools.
// The upstream formats vary by llama.cpp build, so unknown lines deliberately
// remain indeterminate rather than pretending that a percentage is meaningful.

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const NUMBER = "([0-9]+(?:[.,][0-9]+)?)";
const UNITS = "(B|K|KB|KiB|M|MB|MiB|G|GB|GiB|T|TB|TiB)";

const toBytes = (value, unit) => {
  const n = Number(String(value).replace(",", "."));
  const normalized = String(unit).toLowerCase();
  const powers = { b: 0, k: 1, kb: 1, kib: 1, m: 2, mb: 2, mib: 2, g: 3, gb: 3, gib: 3, t: 4, tb: 4, tib: 4 };
  return Number.isFinite(n) ? Math.round(n * 1024 ** (powers[normalized] ?? 0)) : null;
};

const parseBytes = (text) => {
  const match = text.match(new RegExp(`${NUMBER}\\s*${UNITS}`, "i"));
  return match ? toBytes(match[1], match[2]) : null;
};

/**
 * Parse one progress/log line into a stable, UI-safe event.
 * @param {string} line
 * @param {{ downloadedBytes?: number, totalBytes?: number, startedAt?: number }} [previous]
 * @returns {{ downloadedBytes?: number, totalBytes?: number, percent?: number, speedBytesPerSecond?: number, etaSeconds?: number, resumed?: boolean, indeterminate?: boolean }|null}
 */
export function parseDownloadProgress(line, previous = {}) {
  const clean = String(line ?? "").replace(ANSI_RE, "").replace(/\r/g, " ").trim();
  if (!clean) return null;

  const percentMatch = clean.match(new RegExp(`${NUMBER}\\s*%`));
  const percent = percentMatch ? Math.min(100, Math.max(0, Number(percentMatch[1].replace(",", ".")))) : null;
  const pair = clean.match(new RegExp(`${NUMBER}\\s*${UNITS}\\s*(?:/|of)\\s*${NUMBER}\\s*${UNITS}`, "i"));
  let downloadedBytes = pair ? toBytes(pair[1], pair[2]) : parseBytes(clean);
  let totalBytes = pair ? toBytes(pair[3], pair[4]) : null;

  // Some tools print the total only once and then emit percentage-only lines.
  if (downloadedBytes == null && percent != null && previous.totalBytes) {
    downloadedBytes = Math.round(previous.totalBytes * percent / 100);
    totalBytes = previous.totalBytes;
  }
  if (downloadedBytes == null && percent == null) return null;
  totalBytes ??= previous.totalBytes;

  const now = Date.now();
  const startedAt = previous.startedAt ?? now;
  const elapsed = Math.max(0.001, (now - startedAt) / 1000);
  const previousBytes = previous.downloadedBytes ?? downloadedBytes;
  const speedBytesPerSecond = downloadedBytes >= previousBytes
    ? Math.round((downloadedBytes - previousBytes) / elapsed)
    : 0;
  const effectivePercent = percent ?? (totalBytes ? downloadedBytes / totalBytes * 100 : null);
  const etaSeconds = totalBytes && speedBytesPerSecond > 0 && downloadedBytes < totalBytes
    ? Math.ceil((totalBytes - downloadedBytes) / speedBytesPerSecond)
    : null;

  return {
    downloadedBytes,
    ...(totalBytes ? { totalBytes } : {}),
    ...(effectivePercent != null ? { percent: Math.round(effectivePercent * 10) / 10 } : {}),
    ...(speedBytesPerSecond > 0 ? { speedBytesPerSecond } : {}),
    ...(etaSeconds != null ? { etaSeconds } : {}),
    resumed: Boolean(previous.resumed),
    indeterminate: !totalBytes && percent == null,
    startedAt,
  };
}

export const stripAnsi = text => String(text ?? "").replace(ANSI_RE, "");
