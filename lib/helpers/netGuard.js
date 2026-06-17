// lib/helpers/netGuard.js
// REBIND-01 — defends the local server against DNS-rebinding and cross-site
// (CSRF) requests, which matter even in local mode: a malicious web page the
// user is browsing can otherwise script requests at http://127.0.0.1:<port>.
//
// Three checks, applied as one Express middleware:
//   1. Host-header allowlist — every request's Host must resolve to a known
//      hostname. A rebinding attack reaches us with the *attacker's* hostname
//      in Host, so this alone blocks it.
//   2. Origin check — state-changing /api requests with an Origin header must
//      have an allowed origin hostname.
//   3. X-Aperio-Client header — state-changing /api requests must carry this
//      custom header. Browsers can't set custom headers on cross-origin requests
//      without a CORS preflight, and we send no CORS-allow headers, so cross-site
//      JS can never forge it. The first-party UI adds it via public/scripts/http-guard.js.
//
// Opt-out / extend with APERIO_ALLOWED_HOSTS (comma-separated) for proxies/LAN.

const STATE_CHANGING = new Set(["POST", "PUT", "DELETE", "PATCH"]);
export const CLIENT_HEADER = "x-aperio-client";

// Wrap a bare IPv6 literal in brackets so it matches URL.hostname's form.
function normalizeHost(h) {
  const v = String(h).trim().toLowerCase();
  if (!v) return "";
  if (v.includes(":") && !v.startsWith("[") && !v.includes(".")) return `[${v}]`;
  return v;
}

// Parse the hostname out of a Host header (may be "host:port" or "[::1]:port").
export function parseHostHeader(hostHeader) {
  if (!hostHeader) return null;
  try {
    return new URL("http://" + hostHeader).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// Parse the hostname out of an Origin header (a full URL like "http://host:port").
export function parseOriginHost(origin) {
  if (!origin || origin === "null") return null;
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// Build the set of allowed hostnames from the bind host + APERIO_ALLOWED_HOSTS.
export function buildAllowedHosts(host, extraRaw = process.env.APERIO_ALLOWED_HOSTS) {
  const set = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (host) set.add(normalizeHost(host));
  for (const h of String(extraRaw || "").split(",").map(s => s.trim()).filter(Boolean)) {
    set.add(normalizeHost(h));
  }
  set.delete("");
  return set;
}

// Express middleware factory.
export function createNetGuard({ allowedHosts }) {
  return function netGuard(req, res, next) {
    const host = parseHostHeader(req.headers.host);
    if (!host || !allowedHosts.has(host)) {
      return res.status(403).json({ error: "host_not_allowed" });
    }

    if (req.path.startsWith("/api/") && STATE_CHANGING.has(req.method)) {
      const origin = req.headers.origin;
      if (origin) {
        const originHost = parseOriginHost(origin);
        if (!originHost || !allowedHosts.has(originHost)) {
          return res.status(403).json({ error: "origin_not_allowed" });
        }
      }
      if (!req.headers[CLIENT_HEADER]) {
        return res.status(403).json({ error: "client_header_required" });
      }
    }

    next();
  };
}
