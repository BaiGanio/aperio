// tests/helpers/streamingScripts.js
// The browser streaming client is a set of classic scripts sharing globals, so
// load order is part of its contract: state → handler (which owns the event
// router) → renderers → the event-domain files that register into the router.
//
// This list is the single source of truth for the tests. `streaming-router`
// asserts public/index.html loads exactly these files, in this order, so a new
// module cannot be added to the page without the suites picking it up.

export const STREAMING_SCRIPTS = [
  "public/scripts/streaming/state.js",
  "public/scripts/streaming/handler.js",
  "public/scripts/streaming/roundtable.js",
  "public/scripts/streaming/deliverables.js",
  "public/scripts/streaming/badges.js",
  "public/scripts/streaming/tool-cards.js",
  "public/scripts/streaming/interrupts.js",
  "public/scripts/streaming/events/lifecycle.js",
  "public/scripts/streaming/events/turn.js",
  "public/scripts/streaming/events/context.js",
  "public/scripts/streaming/events/knowledge.js",
  "public/scripts/streaming/events/tools.js",
  "public/scripts/streaming/events/roundtable.js",
];
