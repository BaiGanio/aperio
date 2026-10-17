// Decide how an unbootstrapped process should enter setup. A configured local
// launcher (`npm run start:local`) is already an explicit provider choice, so
// it can bootstrap without making a non-technical user repeat that choice in
// the browser. A truly unconfigured `npm start` still needs the wizard.
export function planFirstRun({ hasEnv, provider, model, defaultLocalModel }) {
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  const local = normalizedProvider === "llamacpp";

  if (!hasEnv && !local) return { mode: "wizard" };

  return {
    mode: "bootstrap",
    engine: local ? "llamacpp" : null,
    model: local ? (model || defaultLocalModel) : model,
    // A copied .env.example and start:local both promise a working local
    // install. On a cold machine that necessarily includes fetching the model.
    pullModel: local,
    stashLauncherChoice: !hasEnv && local,
  };
}
