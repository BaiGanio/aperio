import { UI } from "./ui.ts";
import { Config } from "./config.ts";
import * as path from "node:path";

export class NPM {
  static async ensureReady(): Promise<void> {
    await this.ensureNodeInstalled();
    await this.installDependencies();
  }

  private static async isNodeInstalled(): Promise<boolean> {
    const checkCmd = Deno.build.os === "windows" ? "where" : "which";
    const { success } = await new Deno.Command(checkCmd, {
      args: ["node"], stdout: "null", stderr: "null",
    }).output();
    return success;
  }

  private static async ensureNodeInstalled(): Promise<void> {
    if (await this.isNodeInstalled()) {
      UI.ok("Node.js is already installed.");
      await Config.save({ installed: { node: false } as never });
      return;
    }

    UI.info("Node.js missing. Installing LTS version silently...");
    const os = Deno.build.os;

    try {
      if (os === "linux") {
        // NodeSource official setup for Node 20 LTS — works on Debian, Ubuntu, Fedora, etc.
        await this.runShell(
          `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs 2>/dev/null` +
          ` || (curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - && sudo yum install -y nodejs 2>/dev/null)`
        );
      } else if (os === "darwin") {
        // Official macOS pkg installer for Node 20 LTS
        await this.runShell(
          `curl -fsSL https://nodejs.org/dist/lts/node-v20-latest.pkg -o /tmp/node.pkg` +
          ` && sudo installer -pkg /tmp/node.pkg -target /` +
          ` && rm /tmp/node.pkg`
        );
      } else if (os === "windows") {
        // Official MSI for Node 20 LTS, silent install
        const ps = [
          `$url = (Invoke-RestMethod https://nodejs.org/dist/index.json | Where-Object { $_.lts } | Select-Object -First 1).files | Where-Object { $_ -like '*-x64.msi' } | ForEach-Object { "https://nodejs.org/dist/$($_.version)/$_" }`,
          `Invoke-WebRequest -Uri $url -OutFile "$env:TEMP\\node.msi"`,
          `Start-Process msiexec.exe -ArgumentList '/i', "$env:TEMP\\node.msi", '/quiet', '/norestart' -Wait`,
          `Remove-Item "$env:TEMP\\node.msi"`,
        ].join("; ");
        await new Deno.Command("powershell", {
          args: ["-NoProfile", "-NonInteractive", "-Command", ps],
          stdout: "inherit", stderr: "inherit",
        }).output();
      }

      if (!await this.isNodeInstalled()) {
        throw new Error("Node binary still not found after install.");
      }
      await Config.save({ installed: { node: true } as never });
      UI.ok("Node.js installed.");
    } catch (error) {
      UI.die(`Node.js installation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  static async installDependencies(): Promise<void> {
    UI.info("Installing Express dependencies (npm install)...");

    // Run npm install in the same directory as the binary,
    // where package.json lives — not wherever the user launched from
    const binDir = path.dirname(Deno.execPath());

    const { success } = await new Deno.Command("npm", {
      args: ["install", "--no-fund", "--no-audit", "--loglevel=error"],
      cwd: binDir,   // ← this is the fix
      stdout: "inherit",
      stderr: "inherit",
    }).output();

    if (!success) throw new Error("npm install failed. Check your package.json.");
    await Config.save({ installed: { npmPackages: true } as never });
    UI.ok("Dependencies ready.");
  }

  private static async runShell(script: string): Promise<void> {
    const { success } = await new Deno.Command("bash", {
      args: ["-c", script],
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    if (!success) throw new Error(`Shell script failed: ${script.slice(0, 80)}`);
  }
}