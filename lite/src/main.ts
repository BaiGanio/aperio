import { UI } from "./ui.ts";
import { Config } from "./config.ts";
import { Hardware } from "./hardware.ts";
import { Port } from "./port.ts";
import { ModelPicker } from "./model-picker.ts";
import { Ollama } from "./ollama.ts";
import { NPM } from "./npm.ts";
import { Server } from "./server.ts";
import { Setup } from "./setup.ts";
import { load } from "@std/dotenv";
import * as path from "node:path";

const binDir = path.dirname(Deno.execPath());
await load({ export: true, envPath: path.join(binDir, ".env.lite") });

const PORT            = Number(Deno.env.get("PORT")) || 3000;
const EMBEDDING_MODEL = Deno.env.get("OLLAMA_EMBEDDING_MODEL") || "nomic-embed-text";
const FORCED_MODEL    = Deno.env.get("OLLAMA_MODEL") || "";
const flags           = Deno.args;
const isDebug         = flags.includes("--debug") || flags.includes("-d");

async function main() {
  UI.printBanner();

  try {
    // 1. Port
    UI.section("CHECKING PORT AVAILABILITY...");
    await Port.forceFree(PORT);
    if (!Port.isAvailable(PORT)) {
      UI.die(`Port ${PORT} is still locked by the OS. Please close apps using it.`);
    }
    UI.info(`Using port: ${PORT}`);

    // 2. Hardware (needed for recommendation either way)
    const stats = await Hardware.getStats();

    // 3. Model selection
    let config = await Config.load();

    if (FORCED_MODEL) {
      // .env.lite hard-override — skip all prompts
      config = await Config.save({ ...config, ollamaModel: FORCED_MODEL });
      UI.info(`Model forced by .env.lite: ${FORCED_MODEL}`);

    } else if (config.ollamaModel) {
      // Returning user — ask if they want to keep or change
      UI.info(`Current model: ${UI.B(config.ollamaModel)}`);
      const keep = confirm(`  Keep this model and continue? (n to pick a different one)`);

      if (!keep) {
        const selectedModel = await ModelPicker.showMenu(stats);
        config = await Config.save({ ...config, ollamaModel: selectedModel });
      }

    } else {
      // First run — go through full picker
      UI.printPreInstallManifest(isDebug, EMBEDDING_MODEL);
      await UI.confirmOrExit("Ready to start setup?");

      const selectedModel = await ModelPicker.showMenu(stats);
      config = await Config.save({ ...config, ollamaModel: selectedModel });
    }

    // 4. Ollama
    UI.section("CHECKING OLLAMA");
    await Ollama.ensureReady();
    await Ollama.pullModels(config.ollamaModel!, EMBEDDING_MODEL);

    // 5. Node + npm
    UI.section("VERIFIES NODE AND INSTALL DEPENDENCIES");
    await NPM.ensureReady();

    // 6. Uninstall scripts
    UI.section("GENERATING UNINSTALL SCRIPTS");
    await Setup.generateUninstalls(config); 
    UI.ok("Maintenance scripts generated.");

    // 7. Launch
    UI.section("LAUNCHING SERVER");
    UI.info("Starting Aperio-lite server...");

    const serverProcess = await Server.start(PORT, config, isDebug);

    Deno.addSignalListener("SIGINT", async () => {
      UI.warn("\nShutting down safely...");
      await Server.stop();
      Deno.exit(0);
    });

    await serverProcess.status;

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    UI.die(`Launcher Error: ${message}`);
  }
}

if (import.meta.main) {
  main();
}