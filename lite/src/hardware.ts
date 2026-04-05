export interface HardwareStats {
  os: string;
  ramGB: number;
  freeDiskGB: number;
  recommendedModel: string;
  requiredDiskGB: number;
}

export class Hardware {
  /**
   * Replicates flow_hardware_analysis from the .sh file
   */
  static async getStats(): Promise<HardwareStats> {
    const os = Deno.build.os;
    
    // 1. Get RAM (Native Deno)
    const totalMemoryBytes = Deno.systemMemoryInfo().total;
    const ramGB = Math.round(totalMemoryBytes / (1024 ** 3));

    // 2. Logic: Recommend Model based on RAM (Mirroring your script)
    let recommendedModel = "llama3.1:8b";
    if (ramGB <= 8) {
      recommendedModel = "qwen2.5:3b";
    } else if (ramGB >= 36) {
      recommendedModel = "deepseek-r1:7b";
    } else if (ramGB >= 32) {
      recommendedModel = "gemma4:26b";
    } else if (ramGB >= 24) {
      recommendedModel = "qwen3:14b";
    } else if (ramGB >= 16) {
      recommendedModel = "qwen3:8b";
    }

    // 3. Logic: Set Required Disk space based on model string
    let requiredDiskGB = 6;
    if (recommendedModel.includes("32b")) requiredDiskGB = 20;
    else if (recommendedModel.includes("14b")) requiredDiskGB = 10;
    else if (recommendedModel.includes("8b")) requiredDiskGB = 6;
    else if (recommendedModel.includes("3b")) requiredDiskGB = 3;

    // 4. Get Free Disk Space (Platform Specific)
    const freeDiskGB = await this.getFreeDiskSpace();

    return {
      os,
      ramGB,
      freeDiskGB,
      recommendedModel,
      requiredDiskGB
    };
  }

  private static async getFreeDiskSpace(): Promise<number> {
    try {
      // Use Deno.makeTempDir to find the current drive/partition context
      const { available } = await Deno.statfs(".");
      // statfs returns bytes, convert to GB
      return Math.floor(Number(available) / (1024 ** 3));
    } catch {
      // Fallback: if statfs fails, try a shell command
      const cmd = Deno.build.os === "windows" 
        ? ["powershell", "-Command", "(Get-PSDrive C).Free / 1GB"]
        : ["df", "-g", "."];
      
      const process = new Deno.Command(cmd[0], { args: cmd.slice(1), stdout: "piped" });
      const { stdout } = await process.output();
      const output = new TextDecoder().decode(stdout);
      
      // Basic parser for 'df -g' or PS output
      const match = output.match(/(\d+)/);
      return match ? parseInt(match[1]) : 0;
    }
  }
}
