import { existsSync } from "fs";
import { delimiter, resolve } from "path";

export function llamaCppBinaryName(platform = process.platform) {
  return platform === "win32" ? "llama-server.exe" : "llama-server";
}

export function resolveLlamaCppVendorDir(env = process.env, cwd = process.cwd()) {
  return resolve(cwd, env.LLAMACPP_VENDOR_DIR || "vendor/llamacpp");
}

export function resolveLlamaCppCommand({
  env = process.env,
  cwd = process.cwd(),
  platform = process.platform,
  exists = existsSync,
} = {}) {
  const name = llamaCppBinaryName(platform);
  const vendored = resolve(resolveLlamaCppVendorDir(env, cwd), name);
  return exists(vendored) ? vendored : name;
}

export function ensureLlamaCppVendorOnPath({
  env = process.env,
  cwd = process.cwd(),
  platform = process.platform,
  exists = existsSync,
} = {}) {
  const dir = resolveLlamaCppVendorDir(env, cwd);
  if (!exists(resolve(dir, llamaCppBinaryName(platform)))) return false;
  const entries = String(env.PATH || "").split(delimiter).filter(Boolean);
  if (!entries.includes(dir)) env.PATH = [dir, ...entries].join(delimiter);
  return true;
}
