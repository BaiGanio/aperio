import { once } from "node:events";
import net from "node:net";
import { WebSocket } from "ws";
import { evaluateBenchmarkCase } from "../../lib/helpers/modelTierBench.js";

export async function freePort() {
  const server = net.createServer();
  server.unref();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise(resolveClose => server.close(resolveClose));
  return port;
}

export async function api(baseURL, path, options = {}) {
  const response = await fetch(`${baseURL}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-aperio-client": "model-tier-bench",
      ...(options.headers ?? {}),
    },
    signal: options.signal ?? AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${path} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

export async function connectWhenReady(port, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    let ws;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const handshake = [];
      ws.on("message", raw => handshake.push(JSON.parse(raw.toString())));
      await Promise.race([
        once(ws, "open"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("WebSocket open timeout")), 3_000)),
      ]);
      while (!handshake.some(message => message.type === "session_created")) {
        await Promise.race([
          once(ws, "message"),
          new Promise((_, reject) => setTimeout(() => reject(new Error("handshake timeout")), 5_000)),
        ]);
      }
      return { ws, handshake };
    } catch (error) {
      try { ws?.terminate(); } catch { /* retry with a fresh socket */ }
      lastError = error;
      await new Promise(resolveWait => setTimeout(resolveWait, 750));
    }
  }
  throw new Error(`Aperio did not become WebSocket-ready: ${lastError?.message ?? "timeout"}`);
}

async function waitForHttpReady(baseURL, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      // The Aperio app serves no /health route (readiness on first boot is the
      // WebSocket session_created handshake); only llama-server exposes /health.
      // Probe /api/metrics — a real app endpoint that returns 200 once routes are
      // mounted — otherwise this polled a 404 for the full window and the retry
      // restart could NEVER complete.
      const response = await fetch(`${baseURL}/api/metrics`, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) return;
      lastError = new Error(`/api/metrics returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 750));
  }
  throw new Error(`Aperio did not become HTTP-ready: ${lastError?.message ?? "timeout"}`);
}

export async function closeWebSocket(ws, timeoutMs = 5_000) {
  if (!ws || ws.readyState === WebSocket.CLOSED) return;
  const closed = once(ws, "close").catch(() => {});
  ws.close();
  await Promise.race([closed, new Promise(resolveWait => setTimeout(resolveWait, timeoutMs))]);
  if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
}

export async function waitForRetryReadiness({ baseURL, appPort, httpReady = waitForHttpReady, wsReady = connectWhenReady, close = closeWebSocket } = {}) {
  await httpReady(baseURL);
  const { ws } = await wsReady(appPort);
  await close(ws);
}

export async function modelReady(baseURL, expectedModel, { fetchImpl = fetch } = {}) {
  const health = await fetchImpl(`${baseURL}/health`, { signal: AbortSignal.timeout(3_000) });
  if (!health.ok) throw new Error(`llama.cpp health returned ${health.status}`);
  const response = await fetchImpl(`${baseURL}/v1/models`, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`llama.cpp model list returned ${response.status}`);
  const body = await response.json();
  const models = (body?.data ?? []).map(item => item.id);
  if (!models.includes(expectedModel)) throw new Error(`llama.cpp is ready with ${models.join(", ") || "no model"}, not ${expectedModel}`);
  return true;
}

export function runWsCase(ws, caseDef) {
  return new Promise((resolveCase, reject) => {
    const events = [];
    const started = Date.now();
    const timer = setTimeout(() => {
      const error = new Error(`case ${caseDef.id} timed out`);
      const timeoutEvidence = classifyTimeoutEvidence(events);
      error.timeoutKind = timeoutEvidence.kind;
      error.timeoutEvidence = timeoutEvidence.evidence;
      if (timeoutEvidence.kind === "llamacpp-context-limit") {
        error.code = "LLAMACPP_CONTEXT_LIMIT";
        error.message = `case ${caseDef.id} exceeded llama.cpp context size`;
      }
      finish(error);
    }, caseDef.timeoutMs);
    const onMessage = raw => {
      const event = JSON.parse(raw.toString());
      events.push(event);
      if (event.type === "turn_complete" && event.turnId === caseDef.id) {
        const timeoutEvidence = classifyTimeoutEvidence(events);
        if (timeoutEvidence.kind === "llamacpp-context-limit") {
          const error = new Error(`case ${caseDef.id} exceeded llama.cpp context size`);
          error.code = "LLAMACPP_CONTEXT_LIMIT";
          error.timeoutKind = timeoutEvidence.kind;
          error.timeoutEvidence = timeoutEvidence.evidence;
          finish(error);
        } else {
          finish();
        }
      }
    };
    const onClose = () => finish(new Error(`WebSocket closed during ${caseDef.id}`));
    const onError = error => finish(error);
    function finish(error) {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("close", onClose);
      ws.off("error", onError);
      if (error) {
        error.caseEvents = events;
        error.durationMs = Date.now() - started;
        reject(error);
      }
      else resolveCase({ events, durationMs: Date.now() - started });
    }
    ws.on("message", onMessage);
    ws.once("close", onClose);
    ws.once("error", onError);
    ws.send(JSON.stringify({ type: "chat", text: caseDef.prompt, turnId: caseDef.id }));
  });
}

export function classifyTimeoutEvidence(events = []) {
  const evidence = events.filter(event => {
    const text = JSON.stringify(event);
    return text.includes("exceed_context_size_error") ||
      /exceeds the available context size/i.test(text);
  });
  return {
    kind: evidence.length ? "llamacpp-context-limit" : "generic-model-loop-timeout",
    evidence,
  };
}

function persistedTimeoutEvidence(error) {
  return error?.timeoutKind
    ? { timeoutKind: error.timeoutKind, timeoutEvidence: error.timeoutEvidence ?? [] }
    : {};
}

export async function restoreQualificationState({
  caseDef,
  fixtureContract,
  snapshot,
  restoreDatabase,
  restoreWorkspace,
} = {}) {
  const contract = caseDef?.stateContract;
  if (fixtureContract?.reset?.beforeRetry !== "fresh-session"
    || fixtureContract?.reset?.restore !== "fixture-and-workspace"
    || contract?.reset !== "fresh-session"
    || contract?.restore !== "fixture-and-workspace") {
    throw new Error(`case ${caseDef?.id ?? "unknown"} does not satisfy the retry state contract`);
  }
  if (!snapshot?.database || !snapshot?.workspace) throw new Error("retry state snapshot is incomplete");
  if (typeof restoreDatabase !== "function" || typeof restoreWorkspace !== "function") {
    throw new TypeError("retry state restore callbacks are required");
  }
  await restoreWorkspace(snapshot.workspace);
  await restoreDatabase(snapshot.database);
}

export async function executeBenchmarkCases(cases, {
  runCase,
  verifyCaseState,
  recordEvents = () => {},
  context,
  captureState,
  restoreState,
  createFreshContext,
  disposeContext,
} = {}) {
  if (typeof runCase !== "function") throw new TypeError("runCase is required");
  if (typeof verifyCaseState !== "function") throw new TypeError("verifyCaseState is required");
  const caseResults = [];
  let currentContext = context;

  for (const caseDef of cases) {
    const started = Date.now();
    let events = [];
    let durationMs;
    let eventsRecorded = false;
    let stateSnapshot;
    try {
      stateSnapshot = typeof captureState === "function" ? await captureState(caseDef, currentContext) : undefined;
      const execution = await runCase(caseDef, currentContext);
      events = execution.events;
      durationMs = execution.durationMs;
      eventsRecorded = true;
      recordEvents(caseDef, events, { attempt: 1 });
      const statePassed = await verifyCaseState(caseDef, currentContext);
      const firstResult = {
        durationMs,
        ...evaluateBenchmarkCase(caseDef, events, { statePassed }),
      };
      firstResult.firstAttemptPass = firstResult.status === "pass";
      if (firstResult.status === "fail" && typeof restoreState === "function" && typeof createFreshContext === "function") {
        let retryContext;
        try {
          await restoreState(caseDef, stateSnapshot);
        } catch (error) {
          const wrapped = new Error(`retry state restoration failed: ${error.message}`, { cause: error });
          wrapped.caseEvents = events;
          wrapped.durationMs = Date.now() - started;
          throw wrapped;
        }
        try {
          retryContext = await createFreshContext(caseDef, { attempt: 2, firstResult });
        } catch (error) {
          const wrapped = new Error(`retry context creation failed: ${error.message}`, { cause: error });
          wrapped.caseEvents = events;
          wrapped.durationMs = Date.now() - started;
          throw wrapped;
        }
        currentContext = retryContext;
        try {
          const retryExecution = await runCase(caseDef, retryContext);
          const retryEvents = retryExecution.events;
          recordEvents(caseDef, retryEvents, { attempt: 2 });
          const retryStatePassed = await verifyCaseState(caseDef, retryContext);
          const retryResult = {
            durationMs: retryExecution.durationMs,
            ...evaluateBenchmarkCase(caseDef, retryEvents, { statePassed: retryStatePassed }),
          };
          caseResults.push({
            ...retryResult,
            firstAttemptPass: false,
            retried: true,
            firstAttempt: firstResult,
            retry: retryResult,
          });
        } catch (retryError) {
          const retryEvents = retryError.caseEvents ?? [];
          const retryDurationMs = retryError.durationMs ?? Date.now() - started;
          recordEvents(caseDef, retryEvents, { attempt: 2 });
          caseResults.push({
            ...evaluateBenchmarkCase(caseDef, retryEvents, { statePassed: false }),
            durationMs: retryDurationMs,
            status: "invalid",
            firstAttemptPass: false,
            invalidReason: retryError.message,
            ...persistedTimeoutEvidence(retryError),
            retried: true,
            firstAttempt: firstResult,
            retry: {
              durationMs: retryDurationMs,
              status: "invalid",
              invalidReason: retryError.message,
              ...persistedTimeoutEvidence(retryError),
            },
          });
        } finally {
          try { await disposeContext?.(retryContext); } catch { /* best effort */ }
        }
      } else {
        caseResults.push(firstResult);
      }
    } catch (error) {
      events = error.caseEvents ?? events;
      durationMs = error.durationMs ?? durationMs ?? Date.now() - started;
      if (!eventsRecorded) recordEvents(caseDef, events, { attempt: 1 });
      caseResults.push({
        durationMs,
        ...evaluateBenchmarkCase(caseDef, events, { statePassed: false }),
        status: "invalid",
        invalidReason: error.message,
        ...persistedTimeoutEvidence(error),
      });
      error.caseResults = caseResults;
      throw error;
    }
  }
  return caseResults;
}

export async function verifyState(baseURL, assertion, { apiCall = api } = {}) {
  if (!assertion || assertion.kind === "none") return true;
  if (assertion.kind === "memory") {
    const { raw = [] } = await apiCall(baseURL, "/api/memories");
    return raw.some(memory => {
      if (assertion.type && memory.type !== assertion.type) return false;
      const haystack = `${memory.title ?? ""}\n${memory.content ?? ""}`.toLowerCase();
      return (assertion.contentIncludes ?? []).every(term => haystack.includes(String(term).toLowerCase()));
    });
  }
  if (assertion.kind === "wiki") {
    const query = encodeURIComponent(assertion.query);
    const { articles = [] } = await apiCall(baseURL, `/api/wiki/search?q=${query}&mode=fulltext&limit=25`);
    return articles.length >= (assertion.minimumMatches ?? 1);
  }
  return false;
}

export async function importQualificationFixture(baseURL, fixture, {
  request = api,
  now = Date.now,
} = {}) {
  const expectedMemoryCount = 28;
  if (fixture?.memories?.length !== expectedMemoryCount) {
    throw new Error(`qualification fixture must contain exactly ${expectedMemoryCount} memories`);
  }
  const startedAt = now();
  const imported = await request(baseURL, "/api/memories/import", {
    method: "POST",
    body: JSON.stringify(fixture),
  });
  if (imported.imported !== expectedMemoryCount || imported.errors?.length) {
    throw new Error(`fixture import failed: ${JSON.stringify(imported)}`);
  }
  return {
    status: "imported",
    memoryCount: imported.imported,
    durationMs: Math.max(0, now() - startedAt),
  };
}

export async function waitForFixture(baseURL, expected = 28, timeoutMs = 180_000, {
  request = api,
  sleep = resolveWait => new Promise(resolveWaitPromise => setTimeout(resolveWaitPromise, resolveWait)),
  now = Date.now,
} = {}) {
  const startedAt = now();
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const { raw = [] } = await request(baseURL, "/api/memories");
    const tagged = raw.filter(memory => Array.isArray(memory.tags) && memory.tags.includes("aperio-exam"));
    if (tagged.length === expected) {
      const metrics = await request(baseURL, "/api/metrics");
      if (metrics.memories_total >= expected && metrics.embedding_queue_size === 0) {
        return {
          status: "ready",
          expectedMemoryCount: expected,
          taggedMemoryCount: tagged.length,
          embeddingQueueSize: metrics.embedding_queue_size,
          durationMs: Math.max(0, now() - startedAt),
        };
      }
    }
    await sleep(1_000);
  }
  throw new Error(`fixture did not reach exactly ${expected} tagged memories`);
}

export function beginQualificationMeasurement(metrics, readiness) {
  if (readiness?.status !== "ready" || readiness.embeddingQueueSize !== 0) {
    throw new Error("cannot begin qualification measurement before embedding readiness");
  }
  return metrics.beginQualification();
}

// Poll the codegraph/docgraph status endpoints until both finish their initial
// index. The watchers index in the background after boot, so the search tools
// have no data until the pass reaches `ready`. `error` is terminal too: we stop
// waiting and let the dependent cases fail as visible evidence. `idle` is not
// accepted — with both subsystems enabled on a seeded SQLite workspace each
// graph must reach `ready`; a stuck `idle` means a real misconfiguration and
// should surface as a timeout rather than a silent no-data pass.
export async function waitForGraphs(baseURL, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  const terminal = new Set(["ready", "error"]);
  for (const kind of ["codegraph", "docgraph"]) {
    let phase = "indexing";
    while (Date.now() < deadline) {
      phase = (await api(baseURL, `/api/${kind}/status`))?.phase ?? "idle";
      if (terminal.has(phase)) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 1_000));
    }
    if (!terminal.has(phase)) throw new Error(`${kind} did not finish indexing within ${timeoutMs}ms (phase: ${phase})`);
  }
}
