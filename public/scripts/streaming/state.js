// ── Streaming state ───────────────────────────────────────────
let reasoningBubble = null;
let reasoningText = "";
let streamingBubble = null;
let streamingText = "";
let streamStartTime = null;
// Request-scoped wall-clock: spans the WHOLE user turn (send → final answer),
// surviving the per-tool stream_end/stream_start cycles, so the live "#thinking"
// timer keeps counting through the "reading result…" gap between turns.
let requestStartTime = null;
let _liveTimerId = null;
let isReasoningActive = false;
let suggestionShown = false;
let accThinkingTokens = 0;
let accOutputTokens = 0;
let lastUserMsgWrap = null;
let lastReasoningWrapForTok = null;
let prevInputTokens = 0;
let startupBannerShown = false;
let pendingUserTokenEstimate = 0;
let _startupBreakdown = null;
// Whether the active model surfaces reasoning. Non-thinking models must not leave
// a "thinking…" breadcrumb behind — it reads as if the model were still working.
let _modelThinks = false;
// Round-table state. _nextBubbleAgent is set on stream_start and consumed by
// createStreamingBubble() so the bubble is styled with the right agent colour.
// _roundtableAgents is populated from the `provider` event for badge labels.
let _nextBubbleAgent = null;
let _roundtableAgents = [];
let _roundtablePhaseChip = null;
const _pendingGeneratedFiles = [];
// Live tool-activity cards, keyed by the backend `seq` so a tool_result can
// find the card its tool_start created.
const _toolCards = new Map();

// ── Persistent action feed ──────────────────────────────────────────────────
// The live "thinking…/typing…" dots bubble (#thinking) is a single moving
// cursor. To make the sequence of steps trackable, we leave a dim, persistent
// breadcrumb behind each completed reasoning phase and keep that live cursor
// pinned to the bottom of the feed (below any tool cards) instead of letting it
// strand above them with a self-replacing label.
let _lastPhase = null;
// True when the active "thinking" phase already produced a visible reasoning
// bubble — that bubble is the persistent record, so we skip the breadcrumb.
let _phaseHadReasoning = false;

// Per-image vision-token cost. Every upload is normalised to a fixed 896×896
// PNG before reaching the model, so the cost is constant per provider — the
// server reports the active provider's figure in the `provider` event (see
// lib/helpers/imageTokens.js). Falls back to the Anthropic-style estimate until
// that event arrives.
let _imageTokenCost = Math.round((896 * 896) / 750); // ≈ 1070

// Tokens can arrive faster than the browser can paint. Re-rendering the whole
// growing message on every token is O(n²) and freezes the tab on long outputs
// (e.g. a streamed HTML page). Coalesce into at most one render per frame.
let _streamRenderScheduled = false;

let _startupBannerEl = null;
let _startupBannerRefined = false;
