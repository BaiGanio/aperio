// src/config/env-example.js - render .env.example from the registry (spec S2.2).
// Pure and deterministic, so `--check` can compare bytes.

const HEADER = `# Aperio - configuration template (AUTO-GENERATED from src/config/registry.js)
# Run \`npm run gen:env\` after editing the registry; never edit this file by hand.
# Copy to \`.env\` and uncomment only what you change. Every line shows its default.
`;

const TIERS = [
  [0, 'Tier 0 - env only. Bootstrap and security; the Settings DB cannot change these.'],
  [1, 'Tier 1 - the Settings DB may override these (see APERIO_CONFIG_PRECEDENCE).'],
];

/** @param {readonly import('./registry.js').ConfigEntry[]} registry */
export function renderEnvExample(registry) {
  const parts = [HEADER];
  for (const [tier, title] of TIERS) {
    parts.push(`\n# --- ${title}\n`);
    for (const e of registry.filter((x) => x.tier === tier)) {
      const help = e.help.split('\n').map((l) => `# ${l}`.trimEnd()).join('\n');
      const options = e.options ? `\n# Options: ${e.options.join(' | ')}` : '';
      const value = e.secret ? '' : e.default;
      parts.push(`\n${help}${options}\n# ${e.key}=${value}\n`);
    }
  }
  return parts.join('');
}
