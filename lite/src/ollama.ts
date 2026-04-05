import { UI } from "./ui.ts";
import { Config } from "./config.ts";

// The official headless/CLI-only install endpoints per platform
const OLLAMA_LINUX_INSTALL   = "https://ollama.com/install.sh";
const OLLAMA_WIN_INSTALLER   = "https://github.com/ollama/ollama/releases/latest/download/OllamaSetup.exe";
// macOS: we install only the CLI binary from the official tgz release, NOT the .app
const OLLAMA_MAC_ARM_TGZ     = "https://github.com/ollama/ollama/releases/latest/download/ollama-darwin-arm64.tgz";
const OLLAMA_MAC_INTEL_TGZ   = "https://github.com/ollama/ollama/releases/latest/download/ollama-darwin-amd64.tgz";
const OLLAMA_API             = "http://127.0.0.1:11434";

export class Ollama {
  static async ensureReady(): Promise<void> {
    await this.ensureInstalled();
    await this.ensureDaemonRunning();
  }

  // ─── Detection ────────────────────────────────────────────────────────────

  private static async isInstalled(): Promise<boolean> {
    const check = Deno.build.os === "windows" ? "where" : "which";
    const { success } = await new Deno.Command(check, {
      args: ["ollama"],
      stdout: "null",
      stderr: "null",
    }).output();
    return success;
  }

  // ─── Install (headless / CLI only) ────────────────────────────────────────

  public static async ensureInstalled(): Promise<void> {
    if (await this.isInstalled()) {
      UI.ok("Ollama is already installed.");
      // Pre-existing — we did NOT install it, so don't claim we did
      await Config.save({ installed: { ollama: false } as never });
      return;
    }
  
    UI.info("Ollama not found. Installing CLI engine (no UI)...");
    
    switch (Deno.build.os) {
      case "linux":
        await this.installLinux();
        break;
      case "darwin":
        await this.installMac();
        break;
      case "windows":
        await this.installWindows();
        break;
      default:
        throw new Error(`Unsupported OS: ${Deno.build.os}`);
    }
  
    // Record that WE installed it
    await Config.save({ installed: { ollama: true } as never });
    UI.ok("Ollama CLI engine installed successfully.");
  }

  private static async installLinux(): Promise<void> {
    // Official one-liner — pipes directly into sh, no GUI involved
    const { success } = await new Deno.Command("bash", {
      args: ["-c", `curl -fsSL ${OLLAMA_LINUX_INSTALL} | sh`],
      stdout: "inherit",
      stderr: "inherit",
    }).output();

    if (!success) throw new Error("Linux Ollama install failed.");
  }

  private static async installMac(): Promise<void> {
    // Detect architecture
    const archResult = await new Deno.Command("uname", { args: ["-m"], stdout: "piped" }).output();
    const arch = new TextDecoder().decode(archResult.stdout).trim(); // "arm64" or "x86_64"
    const tgzUrl = arch === "arm64" ? OLLAMA_MAC_ARM_TGZ : OLLAMA_MAC_INTEL_TGZ;

    // Download the tgz, extract just the `ollama` binary, install to /usr/local/bin
    // This gives you ONLY the CLI — no Ollama.app, no menu bar icon, no GUI at all
    const script = [
      `curl -fsSL "${tgzUrl}" -o /tmp/ollama.tgz`,
      `tar -xzf /tmp/ollama.tgz -C /tmp`,
      `chmod +x /tmp/ollama`,
      `sudo mv /tmp/ollama /usr/local/bin/ollama`,
      `rm -f /tmp/ollama.tgz`,
    ].join(" && ");

    const { success } = await new Deno.Command("bash", {
      args: ["-c", script],
      stdout: "inherit",
      stderr: "inherit",
    }).output();

    if (!success) throw new Error("macOS Ollama CLI install failed.");
  }

  private static async installWindows(): Promise<void> {
    // Downloads the official installer and runs it with /VERYSILENT to suppress all UI
    // Inno Setup flags: /VERYSILENT suppresses everything including the tray icon setup
    const script = [
      `$tmp = "$env:TEMP\\OllamaSetup.exe"`,
      `Invoke-WebRequest -Uri "${OLLAMA_WIN_INSTALLER}" -OutFile $tmp`,
      `Start-Process -FilePath $tmp -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -Wait`,
      `Remove-Item $tmp`,
    ].join("; ");

    const { success } = await new Deno.Command("powershell", {
      args: ["-NoProfile", "-NonInteractive", "-Command", script],
      stdout: "inherit",
      stderr: "inherit",
    }).output();

    if (!success) throw new Error("Windows Ollama install failed.");
  }

  // ─── Daemon ───────────────────────────────────────────────────────────────

  private static async isDaemonRunning(): Promise<boolean> {
    try {
      const res = await fetch(`${OLLAMA_API}/api/tags`);
      return res.ok;
    } catch {
      return false;
    }
  }

  private static async ensureDaemonRunning(): Promise<void> {
    if (await this.isDaemonRunning()) {
      UI.ok("Ollama daemon already running.");
      return;
    }

    UI.info("Starting Ollama background service...");

    new Deno.Command("ollama", {
      args: ["serve"],
      stdout: "null",
      stderr: "null",
    }).spawn(); // intentionally not awaited — runs as sidecar

    // Poll the real API endpoint, not the root
    for (let i = 0; i < 30; i++) {
      if (await this.isDaemonRunning()) {
        UI.ok("Ollama daemon is ready.");
        return;
      }
      await new Promise(r => setTimeout(r, 500));
    }

    throw new Error("Ollama daemon failed to start within 15 seconds.");
  }

  // ─── Model pulling ────────────────────────────────────────────────────────

  static async pullModels(llmModel: string, embedModel: string): Promise<void> {
    UI.section(`DOWNLOADING AI MODEL — ${llmModel}`);
    await this.runPull(llmModel);
    await Config.save({ installed: { ollamaModels: [llmModel] } as never });
    UI.ok("AI model ready!");
  
    if (embedModel) {
      UI.section(`DOWNLOADING EMBEDDING MODEL — ${embedModel}`);
      await this.runPull(embedModel);
      await Config.save({ installed: { ollamaModels: [embedModel] } as never });
      // Config.save merges the arrays so both models are tracked
      UI.ok("Embeddings ready!");
    }
  }

  private static async runPull(modelName: string): Promise<void> {
    const { success } = await new Deno.Command("ollama", {
      args: ["pull", modelName],
      stdout: "inherit",
      stderr: "inherit",
    }).output();

    if (!success) throw new Error(`Failed to pull model: ${modelName}`);
  }
}