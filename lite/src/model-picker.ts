import { UI } from "./ui.ts";
import { HardwareStats } from "./hardware.ts";

export class ModelPicker {
  /**
   * Replicates flow_model_picker from your .sh file.
   * Allows the user to override the hardware-recommended model.
   */
  static async showMenu(stats: HardwareStats): Promise<string> {
    const currentModel = stats.recommendedModel;

    // Use the interactive UI selector we defined in ui.ts
    const choice = await UI.showModelPicker(currentModel);

    // If the user just hits Enter or picks the default, choice will equal currentModel
    if (choice === currentModel) {
      UI.info(`Keeping auto-selected model: ${UI.B(currentModel)}`);
    }

    return choice;
  }
}
