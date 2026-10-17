// public/scripts/streaming/events/roundtable.js
// Round-table deliberation events and the Discuss entry flow
// (summarize → confirm → staged notes).

onStreamEvent("roundtable_phase", (msg) => {
  _renderRoundtablePhaseChip(msg.phase, msg.agent_id);
});

onStreamEvent("roundtable_agreed", (msg) => {
  _renderConsensusBubble(msg);
});

onStreamEvent("roundtable_no_agreement", (msg) => {
  _renderNoAgreementCard(msg);
});

onStreamEvent("roundtable_error", (msg) => {
  _renderRoundtableErrorCard(msg);
});

onStreamEvent("discuss_summary", (msg) => {
  removeThinking();
  if (msg.ok && msg.text) _renderDiscussSummaryCard(msg.text);
  // ok:false → nothing to summarize; the toggle is already armed silently.
});

onStreamEvent("discuss_staged", () => {
  _renderDiscussStagedNotes();
});

onStreamEvent("discuss_declined", () => {
  _renderDiscussNote("primary", t("discuss_declined_note"));
});
