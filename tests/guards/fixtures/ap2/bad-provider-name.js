// AP2 violation: branching on a provider name outside src/providers/.
export function supportsTools(provider) {
  if (provider === 'llamacpp') return true;
  return false;
}
