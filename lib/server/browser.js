// lib/server/browser.js — auto-launch the user's browser at boot, honoring
// APERIO_BROWSER / APERIO_BROWSER_ISOLATED / APERIO_BENCHMARK_RUN.

import { mkdirSync } from "fs";
import { resolve } from "path";
import { execFile } from "child_process";
import logger from "../helpers/logger.js";
import { BROWSERS, browserArgsFor } from "../helpers/browserLauncher.js";

export function openBrowser(url, { root, deps = {} } = {}) {
  const _execFile  = deps.execFile  ?? execFile;
  const _mkdirSync = deps.mkdirSync ?? mkdirSync;
  const platform   = deps.platform  ?? process.platform;
  if (process.env.APERIO_BENCHMARK_RUN === "1") return;
  const [cmd, ...args] =
    platform === "darwin" ? ["open", url]
    : platform === "win32" ? ["cmd", "/c", "start", url]
    : ["xdg-open", url];
  const openDefault = () => _execFile(cmd, args, err => {
    if (err) logger.error("⚠️  Could not open browser:", err.message);
  });
  const pref = (process.env.APERIO_BROWSER || "firefox").toLowerCase();
  const b = BROWSERS[pref];
  if (!b) { openDefault(); return; }
  const isolated = ["1", "true", "on", "yes"].includes(
    (process.env.APERIO_BROWSER_ISOLATED || "").toLowerCase());
  let profileDir = null;
  if (isolated && b.family !== "app") {
    profileDir = resolve(root, "var/browser-profiles", pref);
    try { _mkdirSync(profileDir, { recursive: true, mode: 0o700 }); } catch (err) {
      logger.error("⚠️  Could not create browser profile dir:", err.message);
      profileDir = null;
    }
  } else if (isolated) {
    logger.warn(`⚠️  APERIO_BROWSER_ISOLATED ignored: ${pref} has no isolated-profile support.`);
  }
  const bArgs = browserArgsFor(b, url, profileDir);
  const [browserCmd, ...browserArgs] =
    platform === "darwin"
      ? ["open", "-na", b.mac, "--args", ...bArgs]
    : platform === "win32"
      ? ["cmd", "/c", "start", b.win, ...bArgs]
      : [b.bin, ...bArgs];
  _execFile(browserCmd, browserArgs, err => {
    if (err) openDefault();
  });
}
