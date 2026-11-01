// lib/helpers/errorHandler.js
// LOG-01 — terminal Express error handler. Any error thrown by a route that
// isn't handled locally lands here. The full error (message + stack) is logged
// server-side, but the client only ever gets a generic message in production so
// internal paths, query fragments, and stack details don't leak to a caller.
// Outside production the real message is returned to keep debugging ergonomic.

import logger from "./logger.js";
import { randomBytes } from "crypto";

// createErrorHandler({ isProd }) → Express (err, req, res, next) middleware.
// Must be registered AFTER all routes (Express keys error middleware off arity).
export function createErrorHandler({ isProd = process.env.NODE_ENV === "production" } = {}) {
  return (err, req, res, _next) => {
    // A short id correlates the opaque client response with the server log line.
    const errorId = randomBytes(6).toString("hex");
    logger.error(`[${errorId}] ${req.method} ${req.path}:`, err);

    if (res.headersSent) return; // response already streaming — can't rewrite it

    const status = Number.isInteger(err?.status) ? err.status : 500;
    res.status(status).json(
      isProd
        ? { error: "internal_error", errorId }
        : { error: err?.message ?? "internal_error", errorId }
    );
  };
}
