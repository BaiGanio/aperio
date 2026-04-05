import { UI } from "./ui.ts";

export class Port {
  /**
   * Replicates flow_check_port and the cleanup() trap.
   * Forces the specified port to be free by killing existing processes.
   */
  static async forceFree(port: number): Promise<void> {
    UI.info(`Ensuring port ${port} is available...`);

    try {
      if (Deno.build.os === "windows") {
        // Windows: Find PID by port and taskkill /F
        const cmd = new Deno.Command("powershell", {
          args: [
            "-NoProfile",
            "-Command",
            `$proc = Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue; if ($proc) { Stop-Process -Id $proc.OwningProcess -Force -ErrorAction SilentlyContinue }`
          ],
        });
        await cmd.output();
      } else {
        // macOS/Linux: Mirroring your 'lsof -ti :$PORT | xargs kill -9'
        const cmd = new Deno.Command("bash", {
          args: ["-c", `lsof -ti :${port} | xargs kill -9 2>/dev/null || true`],
        });
        await cmd.output();
      }
      
      // Brief pause to allow the OS to release the socket
      await new Promise(resolve => setTimeout(resolve, 500));
      UI.ok(`Port ${port} is now clear.`);
    } catch (err) {
      UI.warn(`Could not force clear port ${port}: ${err.message}`);
    }
  }

  /**
   * Verifies if the port is actually open now.
   */
  static async isAvailable(port: number): Promise<boolean> {
    try {
      const server = Deno.listen({ port, transport: "tcp" });
      server.close();
      return true;
    } catch {
      return false;
    }
  }
}
