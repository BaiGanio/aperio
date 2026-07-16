// Hold a small leading prefix before creating a visible streaming bubble.
// This gives the server time to classify and retract text-form tool calls
// without flashing their raw syntax in the transcript.
(function exposeStreamPrefixGuard(root) {
  const PROBE_CHARS = 48;

  function isSuspiciousLeadingContent(text) {
    const leading = String(text || "").trimStart();
    if (!leading) return false;

    if (/^[<{[]/.test(leading)) return true;
    if (/^(?:calling|invoking|running|executing)\b/i.test(leading)) return true;
    if (/^(?:i['’]?ll|i\s+will|i['’]?m|i\s+am|i\s+need\s+to|let\s+me|let['’]?s)\s+(?:now\s+)?(?:call|calling|invoke|invoking|use|using|run|running|execute|executing)\b/i.test(leading)) return true;

    const firstLine = leading.split(/\r?\n/, 1)[0].trim();
    return /^[a-z][a-z0-9-]*(?:_[a-z0-9-]+)+$/i.test(firstLine);
  }

  function shouldHoldLeadingContent(text) {
    const value = String(text || "");
    const leading = value.trimStart();
    if (!leading) return true;
    if (isSuspiciousLeadingContent(value)) return true;
    return leading.length < PROBE_CHARS && !/\r?\n/.test(leading);
  }

  root.AperioStreamPrefixGuard = Object.freeze({
    PROBE_CHARS,
    isSuspiciousLeadingContent,
    shouldHoldLeadingContent,
  });
})(globalThis);
