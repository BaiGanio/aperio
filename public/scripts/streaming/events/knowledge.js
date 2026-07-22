// public/scripts/streaming/events/knowledge.js
// What the turn produced or drew on: memories, matched skills, generated files
// and answer artifacts, plus the advisory notices about the model's own limits.

onStreamEvent("memories", (msg) => {
  renderMemoriesFromMessage(msg.memories);
});

onStreamEvent("deleted", (msg) => {
  allMemories = allMemories.filter(m => m.id !== msg.id);
  renderMemories(allMemories);
});

onStreamEvent("ttl_chip", (msg) => {
  _renderTtlChip(msg);
});

onStreamEvent("skills_matched", (msg) => {
  if (msg.skills?.length) _renderSkillsChip(msg.skills);
});

onStreamEvent("capability_notice", (msg) => {
  if (msg.kind === "images_dropped") _renderCapabilityNotice(t("images_dropped_notice", { provider: msg.provider }));
});

onStreamEvent("generated_file", (msg) => {
  // The server emits these only after the final answer has streamed, so the
  // answer bubble already exists — attach the download card straight to it.
  // If a bubble is still streaming, keep it pending so stream_end attaches it.
  if (streamingBubble) { _pendingGeneratedFiles.push(msg); return; }
  // Otherwise the answer is already rendered: attach to it, or — if the answer
  // was empty so no bubble exists — stand the card up on its own.
  const lastBubble = [...messagesEl.querySelectorAll(".message.ai .bubble")].at(-1);
  if (lastBubble) lastBubble.appendChild(_buildGeneratedFileCard(msg));
  else messagesEl.appendChild(_buildGeneratedFileCard(msg));
  scrollToBottom();
});

onStreamEvent("answer_artifacts", (msg) => {
  // Normally arrives just after stream_end, so the cards are already finalized
  // and need patching in place; if it beats stream_end, finalization picks it up.
  _answerArtifacts = Array.isArray(msg.files) ? msg.files : [];
  if (!streamingBubble) _applyAnswerArtifactsToLastBubble();
});

onStreamEvent("no_tool_use_detected", (msg) => {
  _renderNoToolWarning(msg.model);
});

onStreamEvent("slow_local_turn_detected", (msg) => {
  _renderSlowTurnWarning(msg.model, msg.genTps, msg.hint);
});
