// Provider-neutral lifecycle middleware runner.
//
// Middleware is registered once, then invoked by hook name in registration
// order. Hooks receive an immutable snapshot of the current request and return
// either:
//   undefined                         continue without changes
//   { update: { ... } }               shallow-merge an immutable update
//   { stop: true, value, update? }    apply the optional update and stop
//
// A failed hook is wrapped with its lifecycle location. Every onError observer
// is notified, but observer failures never replace the original error.

export const LIFECYCLE_HOOKS = Object.freeze([
  "beforeModel",
  "selectTools",
  "beforeTool",
  "afterTool",
  "afterModel",
  "onInterrupt",
  "onError",
]);

const HOOK_SET = new Set(LIFECYCLE_HOOKS);

export class LifecycleMiddlewareError extends Error {
  constructor(hook, middleware, cause) {
    super(`Lifecycle hook "${hook}" failed in middleware "${middleware}": ${cause?.message || String(cause)}`, {
      cause,
    });
    this.name = "LifecycleMiddlewareError";
    this.hook = hook;
    this.middleware = middleware;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Lifecycle requests are data objects, but may contain opaque runtime services
// such as emitters or abort signals. Clone/freeze only arrays and plain objects;
// preserve class instances and functions by identity.
function cloneData(value, seen = new WeakMap()) {
  if (Array.isArray(value)) {
    if (seen.has(value)) return seen.get(value);
    const copy = [];
    seen.set(value, copy);
    for (const item of value) copy.push(cloneData(item, seen));
    return copy;
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) return seen.get(value);
    const copy = Object.create(Object.getPrototypeOf(value));
    seen.set(value, copy);
    for (const [key, item] of Object.entries(value)) copy[key] = cloneData(item, seen);
    return copy;
  }
  return value;
}

function freezeData(value, seen = new WeakSet()) {
  if ((!Array.isArray(value) && !isPlainObject(value)) || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) freezeData(item, seen);
  return Object.freeze(value);
}

function snapshot(value) {
  return freezeData(cloneData(value));
}

function assertHook(hook) {
  if (!HOOK_SET.has(hook)) {
    throw new TypeError(`Unknown lifecycle hook "${hook}". Expected one of: ${LIFECYCLE_HOOKS.join(", ")}`);
  }
}

function validateMiddleware(middleware, index, names) {
  if (!isPlainObject(middleware)) {
    throw new TypeError(`Lifecycle middleware at index ${index} must be an object`);
  }
  const name = middleware.name;
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError(`Lifecycle middleware at index ${index} requires a non-empty name`);
  }
  if (names.has(name)) throw new TypeError(`Duplicate lifecycle middleware name "${name}"`);
  names.add(name);
  for (const key of Object.keys(middleware)) {
    if (key !== "name" && !HOOK_SET.has(key)) {
      throw new TypeError(`Lifecycle middleware "${name}" has unknown field "${key}"`);
    }
  }
  for (const hook of LIFECYCLE_HOOKS) {
    if (middleware[hook] !== undefined && typeof middleware[hook] !== "function") {
      throw new TypeError(`Lifecycle middleware "${name}" hook "${hook}" must be a function`);
    }
  }
  return Object.freeze({ ...middleware, name });
}

function applyResult(current, result, hook, middleware) {
  if (result === undefined || result === null) {
    return { request: current, stopped: false };
  }
  if (!isPlainObject(result)) {
    throw new TypeError(`Lifecycle hook "${hook}" in middleware "${middleware}" must return an object or undefined`);
  }
  const update = result.update;
  if (update !== undefined && !isPlainObject(update)) {
    throw new TypeError(`Lifecycle hook "${hook}" in middleware "${middleware}" returned a non-object update`);
  }
  const request = update === undefined
    ? current
    : snapshot({ ...current, ...cloneData(update) });
  return {
    request,
    stopped: result.stop === true,
    ...(Object.hasOwn(result, "value") ? { value: result.value } : {}),
  };
}

export function createLifecycleRunner(middleware = [], options = {}) {
  if (!Array.isArray(middleware)) {
    throw new TypeError("Lifecycle middleware must be an array");
  }
  const trace = options?.trace;
  if (trace != null && typeof trace?.record !== "function") {
    throw new TypeError("Lifecycle trace must provide record()");
  }
  const now = typeof options?.now === "function" ? options.now : () => performance.now();
  const names = new Set();
  const stack = Object.freeze(middleware.map((item, index) =>
    validateMiddleware(item, index, names)));

  function recordTrace(hook, middleware, startedAt, result, cause = null) {
    if (!trace) return;
    const decision = cause
      ? "error"
      : result?.stop === true
        ? "stop"
        : result?.update !== undefined
          ? "update"
          : "continue";
    try {
      trace.record({
        hook,
        middleware,
        durationMs: now() - startedAt,
        decision,
        ...(cause ? { errorType: cause?.name || "Error" } : {}),
      });
    } catch {
      // Observability must never alter middleware execution.
    }
  }

  async function notifyError(error, request, context) {
    const onErrorErrors = [];
    const errorRequest = snapshot({
      ...request,
      error,
      failedHook: error.hook,
      failedMiddleware: error.middleware,
    });
    for (let index = 0; index < stack.length; index++) {
      const entry = stack[index];
      if (!entry.onError) continue;
      const startedAt = now();
      try {
        const result = await entry.onError(errorRequest, Object.freeze({
          hook: "onError",
          middleware: entry.name,
          index,
          context,
        }));
        recordTrace("onError", entry.name, startedAt, result);
      } catch (cause) {
        recordTrace("onError", entry.name, startedAt, null, cause);
        onErrorErrors.push(new LifecycleMiddlewareError("onError", entry.name, cause));
      }
    }
    if (onErrorErrors.length > 0) {
      Object.defineProperty(error, "onErrorErrors", {
        value: Object.freeze(onErrorErrors),
        enumerable: true,
      });
    }
  }

  return Object.freeze({
    middlewareNames: Object.freeze(stack.map(item => item.name)),

    async run(hook, request = {}, context = undefined) {
      assertHook(hook);
      if (!isPlainObject(request)) {
        throw new TypeError(`Lifecycle request for "${hook}" must be an object`);
      }
      let current = snapshot(request);
      for (let index = 0; index < stack.length; index++) {
        const entry = stack[index];
        const handler = entry[hook];
        if (!handler) continue;
        let result;
        const startedAt = now();
        try {
          result = await handler(current, Object.freeze({
            hook,
            middleware: entry.name,
            index,
            context,
          }));
          const next = applyResult(current, result, hook, entry.name);
          recordTrace(hook, entry.name, startedAt, result);
          current = next.request;
          if (next.stopped) return next;
        } catch (cause) {
          recordTrace(hook, entry.name, startedAt, result, cause);
          const error = cause instanceof LifecycleMiddlewareError
            ? cause
            : new LifecycleMiddlewareError(hook, entry.name, cause);
          if (hook !== "onError") await notifyError(error, current, context);
          throw error;
        }
      }
      return { request: current, stopped: false };
    },
  });
}
