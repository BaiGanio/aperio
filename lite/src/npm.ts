import { UI } from "./ui.ts";

export class NPM {
  /**
   * Replicates flow_npm_install.
   * Verifies Node exists, installs it if missing, then runs npm install.
   */
  static async ensureReady(): Promise<void> {
    await this.ensureNodeInstalled();
    await this.installDependencies();
  }

  private static async isNodeInstalled(): Promise<boolean> {
    const checkCmd = Deno.build.os === "windows" ? "where" : "which";
    const cmd = new Deno.Command(checkCmd, { args: ["node"], stdout: "null", stderr: "null" });
    const { success } = await cmd.output();
    return success;
  }

  private static async ensureNodeInstalled(): Promise<void> {
    if (await this.isNodeInstalled()) return;
    UI.info("Node.js missing. Installing LTS version silently...");

    const os = Deno.build.os;
    try {
      if (os === "linux") {
        // Use NodeSource setup script (Debian/Ubuntu/Fedora/etc)
        await this.runShell("curl -fsSL https://nodesource.com | sudo -E bash - && sudo apt-get install -y nodejs");
      } else if (os === "darwin") {
        // Download and install official .pkg
        await this.runShell("curl -L https://nodejs.org -o node.pkg && sudo installer -pkg node.pkg -target / && rm node.pkg");
      } else if (os === "windows") {
        // PowerShell silent MSI install
        const psCmd = "Invoke-WebRequest -Uri https://nodejs.org -OutFile node.msi; Start-Process msiexec.exe -ArgumentList '/i node.msi /quiet /norestart' -Wait; Remove-Item node.msi";
        await new Deno.Command("powershell", { args: ["-NoProfile", "-Command", psCmd] }).output();
      }
      UI.ok("Node.js installed.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      UI.die(`Node.js installation failed: ${message}`);
    }
  }

  /**
   * Runs 'npm install' with filtered output to keep the UI clean.
   */
  static async installDependencies(): Promise<void> {
    UI.info("Installing Express dependencies (npm install)...");
    
    const cmd = new Deno.Command("npm", {
      args: ["install", "--no-fund", "--no-audit", "--loglevel=error"],
      stdout: "inherit",
      stderr: "inherit",
    });

    const { success } = await cmd.output();
    if (!success) throw new Error("npm install failed. Check your package.json.");
    UI.ok("Dependencies ready.");
  }

  private static async runShell(script: string) {
    const cmd = new Deno.Command("bash", { args: ["-c", script] });
    return await cmd.output();
  }
}
