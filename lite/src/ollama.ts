import { UI } from "./ui.ts";

export class Ollama {
  /**
   * Orchestrates silent install and ensures the daemon is running.
   */
  static async ensureReady(): Promise<void> {
    await this.ensureInstalled();
    await this.ensureDaemonRunning();
  }

  private static async isInstalled(): Promise<boolean> {
    const checkCmd = Deno.build.os === "windows" ? "where" : "which";
    const cmd = new Deno.Command(checkCmd, { args: ["ollama"], stdout: "null", stderr: "null" });
    const { success } = await cmd.output();
    return success;
  }

  public static async ensureInstalled(): Promise<void> {
    if (await this.isInstalled()){
      UI.ok("Ollama is already installed.");
      return;
    } 
    UI.info("Ollama missing. Installing silently... This may take a few minutes.");

    const os = Deno.build.os;
    let installCmd: Deno.Command;

    if (os === "linux") {
      // Official silent install for Linux
      installCmd = new Deno.Command("bash", {
        args: ["-c", "curl -fsSL https://ollama.com | sh"],
      });
    } else if (os === "darwin") {
      // Mac silent: Download, unzip, and move to Applications
      installCmd = new Deno.Command("bash", {
        args: ["-c", "curl -L https://ollama.com -o ollama.zip && unzip -qq ollama.zip && mv Ollama.app /Applications/ && rm ollama.zip"],
      });
    } else if (os === "windows") {
      // Windows silent: Download and run installer with /silent flag
      installCmd = new Deno.Command("powershell", {
        args: ["-NoProfile", "-Command", "Invoke-WebRequest -Uri https://ollama.com -OutFile OllamaSetup.exe; Start-Process -FilePath ./OllamaSetup.exe -ArgumentList '/silent' -Wait; Remove-Item OllamaSetup.exe"],
      });
    } else {
      throw new Error("Unsupported OS");
    }

    const { success } = await installCmd.output();
    if (!success) throw new Error("Silent installation failed.");
    UI.ok("Ollama successfully installed.");
  }

  /**
   * Ensures the Ollama serve (daemon) is active so we can pull models.
   */
  private static async ensureDaemonRunning(): Promise<void> {
    // Check if API is already responsive
    try {
      const res = await fetch("http://127.0.0");
      if (res.ok) return;
    } catch {
      UI.info("Starting Ollama background service...");
    }

    // Spawn the daemon as a detached sidecar process
    const cmd = new Deno.Command("ollama", {
      args: ["serve"],
      stdout: "null",
      stderr: "null",
    });
    
    cmd.spawn(); // Do not 'await' this; it needs to stay running in background

    // Poll until the server is ready (max 10 seconds)
    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch("http://127.0.0");
        if (res.ok) return;
      } catch {
        await new Promise(r => setTimeout(r, 500));
      }
    }
    throw new Error("Ollama daemon failed to start.");
  }

  /**
   * Replicates flow_pull_models for both LLM and Embeddings.
   */
  static async pullModels(llmModel: string, embedModel: string): Promise<void> {
    // 1. Primary AI Model
    UI.section(`DOWNLOADING AI MODEL  —  ${llmModel}`);
    await this.runPull(llmModel);
    UI.ok("AI model ready!");

    // 2. Embedding Model
    UI.section(`DOWNLOADING EMBEDDING MODEL  —  ${embedModel}`);
    await this.runPull(embedModel);
    UI.ok("Embeddings ready!");
  }

  /**
   * Internal helper to execute the 'ollama pull' command.
   */
  private static async runPull(modelName: string): Promise<void> {
    const cmd = new Deno.Command("ollama", {
      args: ["pull", modelName],
      stdout: "inherit", // Shows the live progress bar to the user
      stderr: "inherit",
    });

    const { success } = await cmd.output();
    if (!success) {
      throw new Error(`Failed to pull model: ${modelName}`);
    }
  }
}
