// lib/helpers/staticAuth.js
// PATH-02 — gate the /uploads and /scratch static mounts. They serve
// agent/user-generated files (download cards, uploaded attachments) that may be
// sensitive, and were previously world-reachable by anyone who could guess a
// path. Browsers load these via <a>/<img> (no custom headers possible), so the
// gate is a per-process cookie set when the app shell loads. A page from another
// origin can't read the cookie or replay it (httpOnly + SameSite), so it can't
// pull files out of the workspace.

import { isAuthorized } from "./authGuard.js";

export const STATIC_COOKIE = "aperio_static";

function readCookie(header, name) {
  if (!header) return null;
  const m = header.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : null;
}

// Returns Express middleware that allows the request only if it carries the
// per-process static-access cookie, or (when APERIO_AUTH_TOKEN is configured) a
// valid API token — so programmatic clients can still fetch artifacts.
export function createStaticGuard(token) {
  return function staticGuard(req, res, next) {
    if (token && readCookie(req.headers.cookie, STATIC_COOKIE) === token) return next();
    if (process.env.APERIO_AUTH_TOKEN && isAuthorized(req)) return next();
    res.status(403).json({ error: "forbidden" });
  };
}
