import type { AperioConfig } from "./config.ts";
import { UI } from "./ui.ts";
import * as path from "node:path";

const HEARTBEAT_TIMEOUT_MS = 35_000;
const HEARTBEAT_POLL_MS    = 5_000;
const HEARTBEAT_ENDPOINT   = "/api/heartbeat";

export class Server {
  private static process: Deno.ChildProcess | null = null;
  private static heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private static lastHeartbeat = 0;

  // ─── Public API ───────────────────────────────────────────────────────────

  static async start(
    port: number,
    config: Partial<AperioConfig>,
    debug = false,
  ): Promise<Deno.ChildProcess> {
    UI.info(`Starting Express server on port ${port}...`);

    const cmd = new Deno.Command("node", {
      args: ["server.js"],
      cwd: path.dirname(Deno.execPath()),
      env: {
        PORT: port.toString(),
        NODE_ENV: "production",
        AI_PROVIDER: "ollama",
        DB_BACKEND: "lancedb",
        CHECK_RAM: "false",
        OLLAMA_MODEL: config.ollamaModel || "",
      },
      stdout: debug ? "inherit" : "piped",
      stderr: "piped",
    });

    this.process = cmd.spawn();
    this.pipeProcessLogs(this.process, debug);

    const isUp = await Promise.race([
      this.waitForServer(port),
      this.watchForEarlyExit(this.process),
    ]);

    if (!isUp) throw new Error("Server failed to start within 10 seconds.");

    UI.ok("Server is live!");
    await this.openBrowser(port);
    this.startHeartbeatWatcher(port);

    return this.process;
  }

  static async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.process) {
      try { this.process.kill("SIGTERM"); } catch { /* already dead */ }
      await this.process.status.catch(() => {});
      this.process = null;
    }
    await Server.stopOllama();
  }

  // ─── Heartbeat watcher ────────────────────────────────────────────────────

  private static startHeartbeatWatcher(port: number): void {
    this.lastHeartbeat = Date.now();

    this.heartbeatTimer = setInterval(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}${HEARTBEAT_ENDPOINT}`, {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          this.lastHeartbeat = Date.now();
          return;
        }
      } catch {
        // fetch failed — server might be mid-request or browser gone
      }

      const silent = Date.now() - this.lastHeartbeat;
      if (silent >= HEARTBEAT_TIMEOUT_MS) {
        UI.warn(`No browser activity for ${HEARTBEAT_TIMEOUT_MS / 1000}s — shutting down.`);
        await Server.stop();
        Deno.exit(0);
      }
    }, HEARTBEAT_POLL_MS);
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private static pipeProcessLogs(proc: Deno.ChildProcess, debug: boolean): void {
    const decoder = new TextDecoder();

    proc.stderr.pipeTo(new WritableStream({
      write(chunk) {
        const text = decoder.decode(chunk).trim();
        if (text) UI.warn(`[Server]: ${text}`);
      },
    })).catch(() => {});

    if (!debug) {
      proc.stdout?.pipeTo(new WritableStream({ write() {} })).catch(() => {});
    }
  }

  private static async waitForServer(port: number): Promise<true> {
    for (let i = 0; i < 20; i++) {
      try {
        const conn = await Deno.connect({ port, hostname: "127.0.0.1" });
        conn.close();
        return true;
      } catch {
        await new Promise(r => setTimeout(r, 500));
      }
    }
    throw new Error(`Port ${port} never opened — server may have crashed.`);
  }

  private static async watchForEarlyExit(proc: Deno.ChildProcess): Promise<never> {
    const status = await proc.status;
    throw new Error(`Server process exited early with code ${status.code}.`);
  }

  private static async openBrowser(port: number): Promise<void> {
    const url = `http://localhost:${port}`;
    const [command, args]: [string, string[]] =
      Deno.build.os === "windows" ? ["powershell", ["-Command", `Start-Process "${url}"`]]
      : Deno.build.os === "darwin" ? ["open", [url]]
      : ["xdg-open", [url]];

    try {
      await new Deno.Command(command, { args }).output();
    } catch {
      UI.info(`Open your browser at: ${url}`);
    }
  }

  private static async stopOllama(): Promise<void> {
    try {
      if (Deno.build.os === "windows") {
        await new Deno.Command("powershell", {
          args: ["-NoProfile", "-Command",
            "Stop-Process -Name ollama -Force -ErrorAction SilentlyContinue"],
          stdout: "null", stderr: "null",
        }).output();
      } else {
        await new Deno.Command("bash", {
          args: ["-c", "pkill -x ollama 2>/dev/null || true"],
          stdout: "null", stderr: "null",
        }).output();
      }
      UI.ok("Ollama stopped.");
    } catch {
      // non-fatal
    }
  }
}