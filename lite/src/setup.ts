import * as path from "node:path";
import type { AperioConfig } from "./config.ts";

const binDir = path.dirname(Deno.execPath());

export class Setup {
  static async generateUninstalls(config: Partial<AperioConfig>): Promise<void> {
    const installed = config.installed ?? {
      ollama: false,
      node: false,
      ollamaModels: [],
      npmPackages: false,
    };

    if (Deno.build.os === "windows") {
      await Setup.writeWindows(
        installed.ollama,
        installed.node,
        installed.ollamaModels,
        installed.npmPackages,
      );
    } else {
      // covers both macOS and Linux
      await Setup.writeMacLinux(
        installed.ollama,
        installed.node,
        installed.ollamaModels,
        installed.npmPackages,
      );
    }
  }

  // ─── macOS + Linux ────────────────────────────────────────────────────────

  private static async writeMacLinux(
    weInstalledOllama: boolean,
    weInstalledNode: boolean,
    ourModels: string[],
    weInstalledPackages: boolean,
  ): Promise<void> {
    const ollamaSection = weInstalledOllama ? `
# ── Remove Ollama binary (we installed this) ─────────────────────────────────
echo "  → Removing Ollama..."
sudo rm -f "$(which ollama 2>/dev/null)"
` : `
# ── Ollama binary was pre-existing — leaving it alone ────────────────────────
echo "  ℹ  Ollama was already on your system before Aperio-lite — leaving it."
`;

    const modelsSection = ourModels.length > 0 ? `
# ── Remove only the models WE pulled ─────────────────────────────────────────
echo "  → Removing AI models pulled by Aperio-lite..."
${ourModels.map(m => `ollama rm "${m}" 2>/dev/null || true`).join("\n")}
` : `
# ── No models were tracked — skipping ────────────────────────────────────────
`;

    const nodeSection = weInstalledNode ? `
# ── Remove Node.js (we installed this) ───────────────────────────────────────
echo "  → Removing Node.js..."
sudo rm -f "$(which node 2>/dev/null)"
sudo rm -f "$(which npm 2>/dev/null)"
sudo rm -rf /usr/local/lib/node_modules/npm
` : `
# ── Node.js was pre-existing — leaving it alone ──────────────────────────────
echo "  ℹ  Node.js was already on your system before Aperio-lite — leaving it."
`;

    const packagesSection = weInstalledPackages ? `
# ── Remove npm packages we installed ─────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -d "$SCRIPT_DIR/node_modules" ]; then
  echo "  → Removing node_modules..."
  rm -rf "$SCRIPT_DIR/node_modules"
fi
` : "";

    const script = `#!/bin/bash
# uninstall.sh — Aperio-lite removal script
# Auto-generated based on what this launcher actually installed on your system.
# Safe to re-run. Only removes what Aperio-lite put here.
set -e

echo ""
echo "  ┌─────────────────────────────────────────────────┐"
echo "  │  Aperio-lite Uninstaller                        │"
echo "  └─────────────────────────────────────────────────┘"
echo ""

# ── 1. Stop running processes ────────────────────────────────────────────────
echo "  → Stopping Aperio-lite (if running)..."
pkill -f "aperio-mac-arm" 2>/dev/null || true
pkill -f "aperio-linux"   2>/dev/null || true
pkill -f "server.js"      2>/dev/null || true
pkill -x ollama           2>/dev/null || true
${ollamaSection}
${modelsSection}
${nodeSection}
${packagesSection}
# ── Remove config and scripts ────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "  → Removing Aperio-lite config..."
rm -f "$SCRIPT_DIR/.aperio-config.json"

echo "  → Removing uninstall scripts..."
rm -f "$SCRIPT_DIR/uninstall.ps1"
rm -f "$SCRIPT_DIR/uninstall.sh"

echo ""
echo "  ✔  Aperio-lite has been fully removed."
echo ""
`;

    const filePath = path.join(binDir, "uninstall.sh");
    await Deno.writeTextFile(filePath, script);
    if (Deno.build.os !== "windows") {
      await new Deno.Command("chmod", { args: ["+x", filePath] }).output();
    }
  }

  // ─── Windows ──────────────────────────────────────────────────────────────

  private static async writeWindows(
    weInstalledOllama: boolean,
    weInstalledNode: boolean,
    ourModels: string[],
    weInstalledPackages: boolean,
  ): Promise<void> {
    const ollamaSection = weInstalledOllama ? `
# Remove Ollama binary (we installed this)
Write-Host "  -> Removing Ollama..."
$ollamaPath = (Get-Command ollama -ErrorAction SilentlyContinue).Source
if ($ollamaPath) { Remove-Item $ollamaPath -Force }
` : `
Write-Host "  i  Ollama was already on your system before Aperio-lite — leaving it."
`;

    const modelsSection = ourModels.length > 0 ? `
# Remove only the models WE pulled
Write-Host "  -> Removing AI models pulled by Aperio-lite..."
${ourModels.map(m => `& ollama rm "${m}" 2>$null`).join("\n")}
` : "";

    const nodeSection = weInstalledNode ? `
# Remove Node.js (we installed this)
Write-Host "  -> Removing Node.js..."
$nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if ($nodePath) { Remove-Item $nodePath -Force }
` : `
Write-Host "  i  Node.js was already on your system before Aperio-lite — leaving it."
`;

    const packagesSection = weInstalledPackages ? `
# Remove npm packages
$nodeModules = Join-Path $scriptDir "node_modules"
if (Test-Path $nodeModules) {
  Write-Host "  -> Removing node_modules..."
  Remove-Item $nodeModules -Recurse -Force
}
` : "";

    const script = `# uninstall.ps1 — Aperio-lite removal script
# Auto-generated based on what this launcher actually installed on your system.
# Right-click → "Run with PowerShell"

$ErrorActionPreference = "SilentlyContinue"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "  +-------------------------------------------------+"
Write-Host "  |  Aperio-lite Uninstaller                        |"
Write-Host "  +-------------------------------------------------+"
Write-Host ""

# ── 1. Stop running processes ────────────────────────────────────────────────
Write-Host "  -> Stopping Aperio-lite (if running)..."
Stop-Process -Name "aperio-win" -Force
Stop-Process -Name "node"       -Force
Stop-Process -Name "ollama"     -Force
${ollamaSection}
${modelsSection}
${nodeSection}
${packagesSection}
# ── Remove config and scripts ────────────────────────────────────────────────
Write-Host "  -> Removing Aperio-lite config..."
Remove-Item (Join-Path $scriptDir ".aperio-config.json") -Force

Write-Host "  -> Removing uninstall scripts..."
Remove-Item (Join-Path $scriptDir "uninstall.sh") -Force
Start-Sleep -Seconds 1
Remove-Item $MyInvocation.MyCommand.Path -Force

Write-Host ""
Write-Host "  OK  Aperio-lite has been fully removed."
Write-Host ""
Read-Host "  Press Enter to close"
`;

    await Deno.writeTextFile(path.join(binDir, "uninstall.ps1"), script);
  }
}