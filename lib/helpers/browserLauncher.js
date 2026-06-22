// Browser launch table + argument builder for opening the Aperio UI in a
// private/incognito window. Kept separate from server.js so the pure
// argument-building logic is unit-testable without booting the server.

// Supported APERIO_BROWSER names → how to launch a private/incognito window.
// `mac` is the .app name for `open -a`, `bin` the Linux binary, `win` the
// Windows executable for `start`. `family` decides the private + profile
// flags: firefox-style (`-private-window` / `--profile <dir>`),
// chromium-style (`--incognito|--inprivate` / `--user-data-dir=<dir>`), or
// `app` for privacy browsers that are private-by-default with no usable CLI
// flags (best-effort launch, no profile isolation).
export const BROWSERS = {
  firefox:  { mac: "Firefox",        bin: "firefox",        win: "firefox",  family: "firefox" },
  "firefox-dev": { mac: "Firefox Developer Edition", bin: "firefox-developer-edition", win: "firefox-developer-edition", family: "firefox" },
  librewolf:{ mac: "LibreWolf",      bin: "librewolf",      win: "librewolf",family: "firefox" },
  mullvad:  { mac: "Mullvad Browser",bin: "mullvad-browser",win: "mullvad-browser", family: "firefox" },
  chrome:   { mac: "Google Chrome",  bin: "google-chrome",  win: "chrome",   family: "chromium" },
  chromium: { mac: "Chromium",       bin: "chromium",       win: "chromium", family: "chromium" },
  brave:    { mac: "Brave Browser",  bin: "brave-browser",  win: "brave",    family: "chromium" },
  edge:     { mac: "Microsoft Edge", bin: "microsoft-edge", win: "msedge",   family: "chromium", private: "--inprivate" },
  tor:      { mac: "Tor Browser",    bin: "tor-browser",    win: "tor",      family: "app" },
  ddg:      { mac: "DuckDuckGo",     bin: "duckduckgo",     win: "DuckDuckGo", family: "app" },
};

// Build the per-browser argument list (private flag, optional isolated
// profile, then the URL). `profileDir` is non-null only in isolated mode.
export function browserArgsFor(b, url, profileDir) {
  if (b.family === "app") return [url]; // private-by-default, no flags
  if (b.family === "firefox") {
    const args = profileDir ? ["--profile", profileDir] : [];
    return [...args, "-private-window", url];
  }
  // chromium family
  const args = profileDir ? [`--user-data-dir=${profileDir}`] : [];
  return [...args, b.private || "--incognito", url];
}
