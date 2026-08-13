# Reasoning toggle semantics

## Observed issue

The global, DB-synced `aperio-reasoning` preference is presented as “Enable reasoning” / “Disable reasoning”, but its current consumers only control whether streamed reasoning is rendered in the browser. The preference is not passed into the agent or provider request, so switching it off does not disable model reasoning or its latency/token cost.

Relevant seams:

- `public/scripts/settings.js` persists and synchronizes the preference.
- `public/scripts/streaming/badges.js` toggles the preference and labels the control.
- `public/scripts/streaming/events/turn.js` suppresses reasoning-bubble rendering when it is off.
- `lib/agent/providers/llamacpp.js` supports request-level thinking suppression, but does not receive this browser preference.

## Decision needed in a later session

Choose and implement one honest contract:

1. Make the preference actually control provider reasoning where supported, with explicit behavior for providers/models that cannot honor it; or
2. Rename and explain it as a display-only “show reasoning” preference.

Verify both UI behavior and the provider request payload. If choosing real provider control, verify latency/token behavior with reasoning-capable local and cloud models and ensure unsupported providers degrade explicitly rather than silently.
