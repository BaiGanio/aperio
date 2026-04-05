import { UI } from "./ui.ts";

export interface AperioConfig {
  ollamaModel: string;
  lastPort: number;
  installDate: string;
  version: string;
}

export class Config {
  private static readonly FILE_NAME = ".aperio-config.json";

  /**
   * Replaces the "fast-path" logic from your .sh file.
   * Reads the local JSON config if it exists.
   */
  static async load(): Promise<Partial<AperioConfig>> {
    try {
      const content = await Deno.readTextFile(this.FILE_NAME);
      return JSON.parse(content);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        const message = error instanceof Error ? error.message : String(error);
        UI.warn(`Could not read config: ${message}`);
      }
      // Return empty object if file doesn't exist or is corrupted
      return {};
    }
  }

  /**
   * Saves the current setup so the user doesn't have to 
   * re-select their hardware/model on the next run.
   */
  static async save(data: Partial<AperioConfig>): Promise<Partial<AperioConfig>> {
    try {
      const current = await this.load();
      const updated = {
        ...current,
        ...data,
        version: "1.0.0",
        installDate: current.installDate || new Date().toISOString(),
      };

      await Deno.writeTextFile(
        this.FILE_NAME,
        JSON.stringify(updated, null, 2)
      );
      
      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      UI.warn(`Failed to save configuration: ${message}`);
      return data;
    }
  }

  /**
   * Checks if we have enough info to skip the setup wizard.
   */
  static isConfigured(config: Partial<AperioConfig>): boolean {
    return !!config.ollamaModel;
  }
}
