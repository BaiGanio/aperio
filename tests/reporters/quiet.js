// Token-thrifty test reporter for agent runs. The default `spec` reporter
// prints one line per passing test — a 1500-test run is ~47KB of "✔ …" noise
// that a small local model pays full context for and learns nothing from. This
// reporter emits ONLY what the model needs to answer "did the tests pass?":
//   • each failing test (name, location, trimmed error) so failures are actionable
//   • the final summary counts (tests / suites / pass / fail / … / duration_ms),
//     which the runner emits as `test:diagnostic` events
//
// Wired into package.json's `test`/`test:ci` scripts only when APERIO_AGENT_RUN
// is set (run_shell sets it). Humans and CI running the scripts directly get the
// full `spec` output unchanged.

const MAX_MSG_CHARS = 600; // cap each failure's message so one blow-up can't flood context

function trim(msg) {
  const s = String(msg ?? "").trim();
  return s.length > MAX_MSG_CHARS ? `${s.slice(0, MAX_MSG_CHARS)}…` : s;
}

export default async function* quietReporter(source) {
  let failures = 0;
  for await (const event of source) {
    const { type, data } = event;

    if (type === "test:fail") {
      // Suite-level "subtestsFailed" events just aggregate their children — the
      // leaf failures are reported separately, so skipping these avoids dupes.
      if (data.details?.error?.failureType === "subtestsFailed") continue;
      failures++;
      const loc = data.file ? ` (${data.file}:${data.line})` : "";
      yield `✖ ${data.name}${loc}\n  ${trim(data.details?.error?.message ?? data.details?.error)}\n`;
    } else if (type === "test:diagnostic") {
      // The trailing summary block (tests/suites/pass/fail/…/duration_ms).
      yield `${data.message}\n`;
    }
  }
  if (failures === 0) yield "\nAll tests passed.\n";
}
