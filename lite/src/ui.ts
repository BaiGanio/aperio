import * as colors from "@std/colors";
import { Select } from "@cliffy/prompt";
import { HardwareStats } from "./hardware.ts";

export class UI {
  static readonly B = (t: string) => colors.bold(t);
  static readonly CY = (t: string) => colors.cyan(t);
  static readonly WH = (t: string) => colors.white(t);
  static readonly GR = (t: string) => colors.green(t);
  static readonly D = (t: string) => colors.gray(t);
  static readonly RD = (t: string) => colors.red(t);
  static readonly MG = (t: string) => colors.magenta(t);
  static readonly YL = (t: string) => colors.yellow(t);
  static readonly BL = (t: string) => colors.blue(t);

  private static spinnerTimer: number | null = null;

  static startSpinner(message: string) {
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let i = 0;
    // Standard terminal 'hide cursor' code
    Deno.stdout.writeSync(new TextEncoder().encode("\x1b[?25l")); 
    
    this.spinnerTimer = setInterval(() => {
      Deno.stdout.writeSync(new TextEncoder().encode(`\r  ${this.CY(frames[i])} ${message}`));
      i = (i + 1) % frames.length;
    }, 80);
  }

  static stopSpinner(message: string) {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      // Show cursor + clear line + print final message
      Deno.stdout.writeSync(new TextEncoder().encode("\x1b[?25h\r\x1b[K")); 
      this.ok(message);
      this.spinnerTimer = null;
    }
  }

  static ok(msg: string) { console.log(`  ${this.GR(this.B("✔"))}  ${msg}`); }
  static warn(msg: string) { console.log(`  ${this.YL(this.B("⚠"))}  ${msg}`); }
  static info(msg: string) { console.log(`  ${this.CY("●")}  ${msg}`); }

  static printBanner() {
    console.log("");
    console.log(`  ${this.B(this.CY("┌──────────────────────────────────────┐"))}`);
    console.log(`  ${this.B(this.CY("│                                      │"))}`);
    console.log(`  ${this.B(this.CY("│   "))}${this.WH(this.B("Aperio-lite"))}  ${this.D("· local AI setup")}    ${this.B(this.CY("│"))}`);
    console.log(`  ${this.B(this.CY("│                                      │"))}`);
    console.log(`  ${this.B(this.CY("└──────────────────────────────────────┘"))}`);
    console.log("");
  }

  static section(title: string) {
    const paddedTitle = title.padEnd(47);
    console.log(`\n  ${this.B(this.BL("┌─────────────────────────────────────────────────┐"))}`);
    console.log(`  ${this.B(this.BL("│  "))}${this.WH(this.B(paddedTitle))}${this.B(this.BL("│"))}`);
    console.log(`  ${this.B(this.BL("└─────────────────────────────────────────────────┘"))}\n`);
  }

  static async showModelPicker(currentModel: string): Promise<string> {
    console.log(`\n  ${this.WH(this.B("Choose a model to install:"))}\n`);

    // Select.prompt IS async, so this stays async
    const selected = await Select.prompt({
      message: `Select model`,
      default: currentModel,
      options: [
        { name: "qwen2.5:3b   ~2 GB — lightest, fast", value: "qwen2.5:3b" },
        { name: "qwen3:8b     ~5 GB — balanced", value: "qwen3:8b" },
        { name: "qwen3:14b    ~9 GB — recommended for 32 GB RAM", value: "qwen3:14b" },
        { name: "llama3.1:8b  ~5 GB — stable alternative", value: "llama3.1:8b" },
      ],
    });

    console.log(""); 
    this.ok(`Selected model: ${this.B(selected)}`);
    return selected;
  }

  static printHardwareTable(stats: HardwareStats, port: number) {
    const divider = this.D("  ────────────────────────────────────────────");
    console.log(`\n  ${this.B(this.CY("  ITEM                  VALUE"))}`);
    console.log(divider);
    
    const row = (label: string, value: string, extra = "") => 
      console.log(`  ${this.CY(label.padEnd(20))}  ${value}  ${this.D(extra)}`);

    row("OS", stats.os);
    row("Total RAM", `${stats.ramGB} GB`);
    row("Free Disk", `${stats.freeDiskGB} GB`);
    row("Recommended AI", this.GR(this.B(stats.recommendedModel)), "← one tier below max");
    row("Port", port.toString());
    
    console.log(`${divider}\n`);
  }

  // Removed 'async' because confirm() is a blocking call in Deno
  static confirmOrExit(message: string) {
    const proceed = confirm(`  ${this.WH(this.B(message))} (y/n)`);
    if (!proceed) {
      this.warn("Operation cancelled by user.");
      Deno.exit(0);
    }
  }

  static die(msg: string) {
    console.error(`\n  ${colors.red(this.B("ERROR:"))} ${msg}`);
    console.log(this.D("  Press any key to exit..."));
    Deno.stdin.setRaw(true);
    const buffer = new Uint8Array(1);
    Deno.stdin.readSync(buffer);
    Deno.stdin.setRaw(false);
    Deno.exit(1);
  }

    /**
   * Replicates print_pre_install_manifest from .sh
   */
  static printPreInstallManifest(isDebug: boolean, embedModel: string) {
    this.printBanner();

    if (isDebug) {
      console.log(`  ${this.MG(this.B("╔══════════════════════════════════════════════╗"))}`);
      console.log(`  ${this.MG(this.B("║       🧪  DEBUG/DRY MODE IS ACTIVE           ║"))}`);
      console.log(`  ${this.MG(this.B("║  Logs will be visible; verify everything.    ║"))}`);
      console.log(`  ${this.MG(this.B("╚══════════════════════════════════════════════╝"))}\n`);
    }

    this.section("WHAT THIS INSTALLER WILL SET UP");

    console.log(`  ${this.WH(this.B("Everything that may land on your system — nothing hidden, nothing extra."))}\n`);

    // Table Header
    const head = (c: string, w: string, s: string) => 
      console.log(`  ${this.B(this.CY(c.padEnd(22) + "  " + w.padEnd(42) + "  " + s))}`);
    
    const row = (c: string, w: string, s: string) => 
      console.log(`  ${this.GR(this.B(c.padEnd(22)))}  ${w.padEnd(42)}  ${s}`);

    head("COMPONENT", "WHERE ON YOUR SYSTEM", "SIZE");
    console.log(`  ${this.D("───────────────────────────────────────────────────────────────────────────────")}`);
    
    row("Node.js + npm", "System Path (if missing)", "~80 MB");
    row("Ollama", "System Path (if missing)", "~50 MB");
    row("AI language model", "Ollama Directory (~/.ollama)", "3–20 GB");
    row("Embedding model", `Ollama Directory (${embedModel})`, "~670 MB");
    row("npm packages", "./node_modules/", "~50 MB");
    row("Config file", "./.aperio-config.json", "< 1 KB");
    
    console.log(`  ${this.D("───────────────────────────────────────────────────────────────────────────────")}`);
    
    console.log(`\n  ${this.YL(this.B("  Total (estimate):"))}  4–21 GB depending on the AI model you choose.`);
    console.log(`\n  ${this.WH("  To remove Aperio-lite completely later, just run:")}`);
    console.log(`  ${this.CY(this.B("      ./uninstall.sh"))}`);
    console.log(`  ${this.D("  It cleans up only what this launcher placed here.")}\n`);
  }

}
