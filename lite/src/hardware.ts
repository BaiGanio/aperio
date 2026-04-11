export interface HardwareStats {
  os: string;
  ramGB: number;
  cpuCores: number;
  gpuVramGB: number;
  freeDiskGB: number;
  recommendedModel: string;
  requiredDiskGB: number;
}

export class Hardware {
  static async getStats(): Promise<HardwareStats> {
    const os = Deno.build.os;

    // 1. RAM
    const totalMemoryBytes = Deno.systemMemoryInfo().total;
    const ramGB = Math.round(totalMemoryBytes / (1024 ** 3));

    // 2. CPU cores
    const cpuCores = navigator.hardwareConcurrency ?? 4;

    // 3. GPU VRAM — best-effort, falls back to 0 (no crash)
    const gpuVramGB = await Hardware.detectGpuVram(os);

    // 4. Recommend model by RAM
    let recommendedModel = "llama3.1:8b"; // default: 9–15 GB RAM
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

    // 5. Required disk based on model
    let requiredDiskGB = 6;
    if (recommendedModel.includes("32b")) requiredDiskGB = 20;
    else if (recommendedModel.includes("14b")) requiredDiskGB = 10;
    else if (recommendedModel.includes("8b")) requiredDiskGB = 6;
    else if (recommendedModel.includes("3b")) requiredDiskGB = 3;

    // 6. Free disk
    const freeDiskGB = await Hardware.getFreeDiskSpace();

    return { os, ramGB, cpuCores, gpuVramGB, freeDiskGB, recommendedModel, requiredDiskGB };
  }

  private static async detectGpuVram(os: string): Promise<number> {
    try {
      let script: string;
      if (os === "darwin") {
        // system_profiler returns VRAM line like "VRAM (Total): 16 GB"
        script = `system_profiler SPDisplaysDataType 2>/dev/null | grep -i "VRAM" | head -1 | grep -o '[0-9]*'`;
      } else if (os === "linux") {
        script = `nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1`;
      } else {
        // Windows: wmic path win32_videocontroller get AdapterRAM
        const { stdout } = await new Deno.Command("powershell", {
          args: ["-NoProfile", "-Command",
            "(Get-CimInstance Win32_VideoController | Sort-Object AdapterRAM -Descending | Select-Object -First 1).AdapterRAM / 1GB"],
          stdout: "piped", stderr: "null",
        }).output();
        const val = Number.parseFloat(new TextDecoder().decode(stdout).trim());
        return Number.isNaN(val) ? 0 : Math.round(val);
      }

      const { stdout } = await new Deno.Command("bash", {
        args: ["-c", script],
        stdout: "piped", stderr: "null",
      }).output();
      const val = Number.parseFloat(new TextDecoder().decode(stdout).trim());
      // nvidia-smi returns MB, macOS returns GB
      if (os === "linux") return Number.isNaN(val) ? 0 : Math.round(val / 1024);
      return Number.isNaN(val) ? 0 : Math.round(val);
    } catch {
      return 0;
    }
  }

  private static async getFreeDiskSpace(): Promise<number> {
    try {
      if (Deno.build.os === "windows") {
        const { stdout } = await new Deno.Command("powershell", {
          args: ["-NoProfile", "-Command", "((Get-PSDrive C).Free / 1GB)"],
          stdout: "piped", stderr: "null",
        }).output();
        const val = Number.parseFloat(new TextDecoder().decode(stdout).trim());
        return Number.isNaN(val) ? 0 : Math.floor(val);
      } else {
        // Works on both macOS and Linux
        // df -k gives kilobytes, 4th column is available
        const { stdout } = await new Deno.Command("df", {
          args: ["-k", "."],
          stdout: "piped", stderr: "null",
        }).output();
        const lines = new TextDecoder().decode(stdout).trim().split("\n");
        const parts = lines[1].trim().split(/\s+/);
        const availableKB = Number.parseInt(parts[3]);
        return Number.isNaN(availableKB) ? 0 : Math.floor(availableKB / (1024 ** 2));
      }
    } catch {
      return 0;
    }
  }

  static getRecommendedModel(ramGB: number): string {
    const tiers = Deno.env.get("MODEL_TIERS") || "";

    if (tiers) {
      // Parse "36:deepseek-r1:7b,32:gemma4:27b,..." — note model names contain colons
      // so we split on comma first, then split each entry on the FIRST colon only
      const sorted = tiers.split(",")
        .map(entry => {
          const idx = entry.indexOf(":");
          return {
            ram: Number.parseInt(entry.slice(0, idx)),
            model: entry.slice(idx + 1),   // everything after first colon
          };
        })
        .filter(t => !Number.isNaN(t.ram))
        .sort((a, b) => b.ram - a.ram);   // highest RAM threshold first

      for (const tier of sorted) {
        if (ramGB >= tier.ram) return tier.model;
      }
      // below all thresholds — return the last (lowest) tier
      return sorted.at(-1)?.model ?? "qwen2.5:3b";
    }

    // Fallback if MODEL_TIERS not set
    if (ramGB >= 36) return "deepseek-r1:7b";
    if (ramGB >= 32) return "gemma4:27b";
    if (ramGB >= 24) return "qwen3:14b";
    if (ramGB >= 16) return "qwen3:8b";
    return "qwen2.5:3b";
  }
}