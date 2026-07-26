export function parseConfigValue(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    if (fallback !== undefined) return fallback;
    throw new Error("parseConfigValue: missing required config value");
  }
  const num = Number(raw);
  if (!Number.isFinite(num)) {
    throw new Error(`parseConfigValue: "${raw}" is not a valid number`);
  }
  return num;
}
