import { UI } from "./ui.ts";
import * as path from "node:path";

export interface InstalledComponents {
  ollama: boolean;         // did WE install ollama, or was it already there?
  node: boolean;           // did WE install node, or was it already there?
  ollamaModels: string[];  // which models did WE pull
  npmPackages: boolean;    // did WE run npm install
}

export interface AperioConfig {
  ollamaModel: string;
  embeddingModel: string;
  lastPort: number;
  installDate: string;
  version: string;
  installed: InstalledComponents;
}

const DEFAULT_INSTALLED: InstalledComponents = {
  ollama: false,
  node: false,
  ollamaModels: [],
  npmPackages: false,
};

export class Config {
  private static get filePath(): string {
    const dir = path.dirname(Deno.execPath());
    return path.join(dir, ".aperio-config.json");
  }

  static async load(): Promise<Partial<AperioConfig>> {
    try {
      const content = await Deno.readTextFile(this.filePath);
      return JSON.parse(content);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        const message = error instanceof Error ? error.message : String(error);
        UI.warn(`Could not read config: ${message}`);
      }
      return {};
    }
  }

  static async save(data: Partial<AperioConfig>): Promise<Partial<AperioConfig>> {
    try {
      const current = await this.load();
      const updated = {
        ...current,
        ...data,
        version: "1.0.0",
        installDate: current.installDate || new Date().toISOString(),
        installed: {
          ...DEFAULT_INSTALLED,
          ...(current.installed ?? {}),
          ...(data.installed ?? {}),
          // Merge ollamaModels — never lose a previously tracked model
          ollamaModels: [
            ...new Set([
              ...((current.installed?.ollamaModels) ?? []),
              ...((data.installed?.ollamaModels) ?? []),
            ])
          ],
        },
      };
      await Deno.writeTextFile(this.filePath, JSON.stringify(updated, null, 2));
      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      UI.warn(`Failed to save configuration: ${message}`);
      return data;
    }
  }

  static isConfigured(config: Partial<AperioConfig>): boolean {
    return !!config.ollamaModel;
  }
}