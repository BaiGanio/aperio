// AP2 green: ask for a capability, never a name.
export function supportsTools(provider) {
  return provider.can('tools');
}
