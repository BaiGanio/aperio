import { UI } from "./ui.ts";
import { AperioConfig } from "./config.ts";

export class Server {
  private static process: Deno.ChildProcess | null = null;

  /**
   * Spawns the Express server and monitors health.
   */
  static async start(port: number, config: Partial<AperioConfig>, debug = false): Promise<Deno.ChildProcess> {
    UI.info(`Starting Express server on port ${port}...`);

    const cmd = new Deno.Command("node", {
      args: ["server.js"], // or your entry point
      env: {
        PORT: port.toString(),
        NODE_ENV: "production",
        AI_PROVIDER: "ollama",
        DB_BACKEND: "lancedb",
        CHECK_RAM: "false", 
        OLLAMA_MODEL: config.ollamaModel || "",
      },
      stdout: debug ? "inherit" : "piped",
      stderr: "piped", // Always capture errors
    });

    this.process = cmd.spawn();

    // 1. Error Monitoring: If not in debug, only show stderr on failure
    if (!debug) {
      this.handleLogs(this.process);
    }

    // 2. Health Check: Wait for the port to become active
    const isUp = await this.waitForServer(port);
    if (isUp) {
      UI.ok("Server is live!");
      await this.openBrowser(port);
    } else {
      throw new Error("Server failed to start within 10 seconds.");
    }

    return this.process;
  }

  private static async handleLogs(process: Deno.ChildProcess) {
      const decoder = new TextDecoder();
      
      // Use a WritableStream to consume stderr and send it to UI.warn
      process.stderr.pipeTo(new WritableStream({
        write(chunk) {
          const errorText = decoder.decode(chunk);
          // We only show errors if they aren't empty/whitespace
          if (errorText.trim()) {
            UI.warn(`[Server Error]: ${errorText}`);
          }
        }
      })).catch(() => {
        // Silently catch stream closing errors
      });

      // Silently consume stdout so the buffer doesn't fill up and hang the process
      process.stdout.pipeTo(new WritableStream({
        write(_chunk) {
          // Do nothing (unless debugging)
        }
      })).catch(() => {});
  }

  private static async waitForServer(port: number): Promise<boolean> {
    for (let i = 0; i < 20; i++) {
      try {
        const conn = await Deno.connect({ port, hostname: "127.0.0.1" });
        conn.close();
        return true;
      } catch {
        await new Promise(r => setTimeout(r, 500));
      }
    }
    return false;
  }

  private static async openBrowser(port: number) {
    const url = `http://localhost:${port}`;
    let command: string;
    let args: string[];

    if (Deno.build.os === "windows") {
      command = "powershell";
      args = ["-Command", `Start-Process "${url}"`];
    } else if (Deno.build.os === "darwin") {
      command = "open";
      args = [url];
    } else {
      command = "xdg-open";
      args = [url];
    }

    try {
      const cmd = new Deno.Command(command, { args });
      await cmd.output();
    } catch {
      UI.info(`Please open your browser at: ${url}`);
    }
  }

  static async stop() {
    if (this.process) {
      this.process.kill("SIGTERM");
      await this.process.status;
    }
  }
}
