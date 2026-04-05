import { UI } from "./ui.ts";

export class Port {
  static async forceFree(port: number): Promise<void> {
    UI.info(`Ensuring port ${port} is available...`);

    try {
      if (Deno.build.os === "windows") {
        await new Deno.Command("powershell", {
          args: [
            "-NoProfile", "-Command",
            `$p = Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue; ` +
            `if ($p) { Stop-Process -Id $p.OwningProcess -Force -ErrorAction SilentlyContinue }`,
          ],
          stdout: "null", stderr: "null",
        }).output();
      } else {
        await new Deno.Command("bash", {
          args: ["-c", `lsof -ti :${port} | xargs kill -9 2>/dev/null || true`],
          stdout: "null", stderr: "null",
        }).output();
      }
      await new Promise(r => setTimeout(r, 500));
      UI.ok(`Port ${port} is clear.`);
    } catch (err) {
      UI.warn(`Could not force-clear port ${port}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  static isAvailable(port: number): boolean {
    try {
      const server = Deno.listen({ port, transport: "tcp" });
      server.close();
      return true;
    } catch {
      return false;
    }
  }
}