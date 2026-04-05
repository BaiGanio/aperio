import { UI } from "./ui.ts";
import { Config } from "./config.ts";
import { Hardware } from "./hardware.ts";
import { Port } from "./port.ts";
import { ModelPicker } from "./model-picker.ts";
import { Ollama } from "./ollama.ts";
import { NPM } from "./npm.ts";
import { Server } from "./server.ts";
import { Setup } from "./setup.ts";
import process from "node:process";

// At the top of src/main.ts
const flags = Deno.args;
const isDebug = flags.includes("--debug") || flags.includes("-d");
const PORT = Number(process.env.PORT) || 3000;
const EMBEDDING_MODEL = process.env.OLLAMA_EMBEDDING_MODEL || "";

async function main() {
  UI.printBanner();

  try {
    const stats = await Hardware.getStats();

    UI.section("CHECKING PORT AVAILABILITY...");
    await Port.forceFree(PORT);
    if (!await Port.isAvailable(PORT)) {
      UI.die(`Port ${PORT} is still locked by the OS. Please close apps using it.`);
    }
    
    UI.info(`Using port: ${PORT}`);

    // 2. Load Configuration (Fast Path)
    let config = await Config.load();
    
    if (config.ollamaModel) {
      UI.info(`Fast-path: Found saved model ${config.ollamaModel}`);
    } else {
      // 3. Pre-install Manifest & Interaction
      UI.printPreInstallManifest(isDebug, EMBEDDING_MODEL);
      await UI.confirmOrExit("Ready to start setup?");

      // 4. Hardware Analysis
      UI.startSpinner("Analyzing hardware...");
      const stats = await Hardware.getStats();
      UI.stopSpinner(`Hardware detected: ${stats.cpuCores} Cores, ${stats.ramGB}GB RAM, ${stats.gpuVramGB}GB VRAM`);

      // 5. Model Picker
      const selectedModel = await ModelPicker.showMenu(stats);
      config = await Config.save({ ...config, ollamaModel: selectedModel });
    }

    UI.section("CHECKING OLLAMA");
    await Ollama.ensureReady();   
    await Ollama.pullModels(config.ollamaModel || stats.recommendedModel, EMBEDDING_MODEL);

    UI.section("VERIFIES NODE AND INSTALL DEPENDENCIES");
    await NPM.ensureReady();

    UI.section("GENERATING UNINSTALL SCRIPTS");
    await Setup.generateUninstalls();
    UI.ok("Maintenance scripts generated.");

    // 7. Launch Express Server
    UI.section("LAUNCHING SERVER");
    UI.info("Starting Aperio-lite server...");

    const serverProcess = await Server.start(PORT, config, isDebug);

    // Graceful Shutdown Handler
    Deno.addSignalListener("SIGINT", async () => {
      UI.warn("\nShutting down safely...");
      await Server.stop();
      Deno.exit(0);
    });

    // Keep the process alive while the server runs
    await serverProcess.status;

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    UI.die(`Launcher Error: ${message}`);
  }
}

if (import.meta.main) {
  main();
}
