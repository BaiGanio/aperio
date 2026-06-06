// Per-image vision-token estimate.
//
// Every uploaded image is normalised to a fixed 896×896 PNG
// (lib/handlers/attachments/workers/preprocessImage.js) before it reaches the
// model, so the cost is effectively constant per provider — it does not depend
// on the original resolution. The figures below are deliberately rough; the UI
// labels them "~".
const NORMALISED_PX = 896 * 896;

export function imageTokenEstimate(providerName) {
  switch (providerName) {
    case "ollama":
    case "gemini":
      // Local / Google VLMs encode a 896² image into a small fixed patch
      // budget (Gemma 3 ≈ 256, Gemini ≈ 258).
      return 256;
    default:
      // Anthropic's documented heuristic — also a fair estimate for the
      // OpenAI-compatible vision endpoints (DeepSeek-VL): tokens ≈ (w × h) / 750.
      return Math.round(NORMALISED_PX / 750); // ≈ 1070
  }
}
