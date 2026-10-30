// lib/helpers/attachmentLimits.js
//
// The ONE attachment size/count budget, shared by every edge that can accept a
// file: the browser (via GET /api/config/client), the terminal client, the
// server-side `processAttachments` chokepoint, and the WebSocket frame cap.
//
// Why this module exists (Aperio Reset, S2.10). Before it there was no limit
// *anywhere* — not in lib/config.js, not server-side, and not in the browser,
// which read any file with `readAsDataURL` and no check at all. The only
// ceiling was accidental: lib/server/ws.js constructed WebSocketServer without
// `maxPayload`, so an oversized attachment did not get refused, it killed the
// connection at a threshold the `ws` library's default happened to pick.
//
// Every value is read from the environment **at call time**, never captured in
// a module-level const: the config resolver injects DB-stored values into
// process.env during boot, so a const frozen at import would read a stale or
// missing value.

// Base64 inflates by 4/3, and the JSON envelope around it costs a little more.
// Used to size the WS frame cap so a *legal* attachment set can never be the
// thing that trips it.
const BASE64_OVERHEAD = 4 / 3;
const ENVELOPE_OVERHEAD = 1.1;

// A floor, so a small or mistyped attachment budget can never shrink the frame
// cap far enough to break ordinary chat traffic.
const MIN_WS_PAYLOAD_BYTES = 8 * 1024 * 1024;

function positiveNumber(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Largest single attachment, in bytes, before base64 encoding. */
export function attachmentMaxBytes() {
  return Math.floor(positiveNumber(process.env.APERIO_ATTACHMENT_MAX_MB, 10) * 1024 * 1024);
}

/** How many attachments one message may carry. */
export function attachmentMaxCount() {
  return Math.floor(positiveNumber(process.env.APERIO_ATTACHMENT_MAX_COUNT, 5));
}

/**
 * The WebSocket frame cap, derived from the attachment budget rather than set
 * by hand, so the two can never contradict each other: a message carrying the
 * maximum legal attachment set always fits, and anything larger is refused by
 * a check that can explain itself instead of by a dropped socket.
 */
export function wsMaxPayloadBytes() {
  const derived = Math.ceil(
    attachmentMaxCount() * attachmentMaxBytes() * BASE64_OVERHEAD * ENVELOPE_OVERHEAD,
  );
  return Math.max(MIN_WS_PAYLOAD_BYTES, derived);
}

/** Human-readable budget, for refusal messages on both clients. */
export function formatMb(bytes) {
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

/**
 * Decoded byte length of a base64 payload, computed from the string's length
 * instead of decoding it — the point of the check is to refuse the file
 * *before* anything allocates a buffer for it.
 */
export function base64Bytes(data) {
  const s = String(data || "");
  if (!s) return 0;
  const padding = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((s.length * 3) / 4) - padding);
}

/**
 * The shared verdict. `bytes` is the decoded size.
 * Returns `{ ok: true }` or `{ ok: false, reason }` with a message both the
 * terminal and the web path can show verbatim.
 */
export function checkAttachmentSize(bytes, name = "file") {
  const max = attachmentMaxBytes();
  if (bytes > max) {
    return {
      ok: false,
      reason: `${name} is ${formatMb(bytes)}, over the ${formatMb(max)} attachment limit `
        + `(APERIO_ATTACHMENT_MAX_MB)`,
    };
  }
  return { ok: true };
}

/** The shared count verdict, for the n-th attachment (0-based). */
export function checkAttachmentCount(index) {
  const max = attachmentMaxCount();
  if (index >= max) {
    return {
      ok: false,
      reason: `only ${max} attachments per message are accepted `
        + `(APERIO_ATTACHMENT_MAX_COUNT)`,
    };
  }
  return { ok: true };
}
