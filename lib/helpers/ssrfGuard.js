// lib/helpers/ssrfGuard.js
// Shared SSRF guard for agent egress (EGRESS-01, supersedes SSRF-01/02).
//
// assertPublicUrl(url) resolves the URL's hostname and throws if it points at a
// loopback / link-local / private / CGNAT / Docker-bridge address — the ranges a
// confused or injected model could use to reach internal services or cloud
// metadata endpoints (169.254.169.254). Call it before any agent-driven fetch.
//
// Opt-outs:
//   APERIO_ALLOW_INTERNAL_FETCH=1  — disable the guard entirely (power users).
//   APERIO_EGRESS_ALLOWLIST=a,b    — when set, only these hosts are reachable.
//
// Note: on DNS resolution failure we allow through — an unresolvable host can't
// connect, so there is no SSRF risk and the underlying fetch fails naturally.

import dns from "node:dns/promises";
import net from "node:net";
import http from "node:http";
import https from "node:https";

// [base, prefixBits] — IPv4 ranges that must never be reached from agent egress.
const BLOCKED_V4 = [
  ["0.0.0.0",      8],   // "this" network
  ["10.0.0.0",     8],   // private
  ["100.64.0.0",  10],   // carrier-grade NAT
  ["127.0.0.0",    8],   // loopback
  ["169.254.0.0", 16],   // link-local (incl. cloud metadata 169.254.169.254)
  ["172.16.0.0",  12],   // private (incl. Docker bridge 172.17.0.0/16)
  ["192.168.0.0", 16],   // private
];

function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, o) => ((acc << 8) >>> 0) + Number(o), 0) >>> 0;
}

function inCidr4(ip, base, bits) {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

function isBlockedV4(ip) {
  return BLOCKED_V4.some(([base, bits]) => inCidr4(ip, base, bits));
}

function isBlockedV6(ip) {
  const a = ip.toLowerCase();
  if (a === "::1" || a === "::") return true;            // loopback / unspecified
  if (a.startsWith("fe80")) return true;                 // link-local
  if (a.startsWith("fc") || a.startsWith("fd")) return true; // unique-local fc00::/7
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
  if (mapped) return isBlockedV4(mapped[1]);
  return false;
}

// True if an IP literal falls in a blocked range. Non-IP input returns false.
export function isBlockedAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) return isBlockedV4(ip);
  if (v === 6) return isBlockedV6(ip);
  return false;
}

export async function assertPublicUrl(url) {
  if (process.env.APERIO_ALLOW_INTERNAL_FETCH === "1") return null;

  let parsed;
  try { parsed = new URL(url); }
  catch { throw new Error(`SSRF guard: invalid URL "${url}".`); }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new Error(`SSRF guard: blocked non-HTTP(S) scheme "${parsed.protocol}".`);

  const host = parsed.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets

  const allowlist = (process.env.APERIO_EGRESS_ALLOWLIST || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  if (allowlist.length && !allowlist.includes(host))
    throw new Error(`SSRF guard: "${host}" is not in APERIO_EGRESS_ALLOWLIST.`);

  // IP literal — check directly, no DNS needed.
  if (net.isIP(host)) {
    if (isBlockedAddress(host))
      throw new Error(`SSRF guard: blocked internal address ${host}.`);
    return { hostname: host, addresses: [{ address: host, family: net.isIP(host) }] };
  }

  // Hostname — resolve and block if ANY resolved address is internal.
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    return { hostname: host, addresses: [] }; // unresolvable: cannot connect, so no SSRF risk
  }
  for (const { address } of addrs) {
    if (isBlockedAddress(address))
      throw new Error(`SSRF guard: "${host}" resolves to internal address ${address}.`);
  }
  return { hostname: host, addresses: addrs };
}

// ── Safe fetch with DNS pinning ───────────────────────────────────────────────
// Wraps fetch() with a validated, pinned DNS lookup so a rebinding attacker
// cannot swap the IP between validation and connection. Redirects are followed
// manually so every Location is re-validated.

function createResponse(status, headersObj, body) {
  const headers = new Headers();
  if (headersObj) {
    for (const [k, v] of Object.entries(headersObj)) {
      if (v != null) headers.set(k, Array.isArray(v) ? v.join(", ") : String(v));
    }
  }
  return {
    status,
    statusText: `${status}`,
    ok: status >= 200 && status < 400,
    headers,
    text: () => Promise.resolve(body ? body.toString("utf8") : ""),
    arrayBuffer: () => {
      if (!body) return Promise.resolve(new ArrayBuffer(0));
      return Promise.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
    },
    json: () => Promise.resolve(JSON.parse(body ? body.toString("utf8") : "")),
  };
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Fetch a URL through the SSRF guard with DNS pinning.
 *
 * 1. Calls assertPublicUrl to validate the host and obtain resolved IPs.
 * 2. Connects to the PINNED IP (via a custom `lookup`) so DNS rebinding
 *    between check and connect is impossible.
 * 3. Disables auto-redirect; every 3xx Location is re-validated through
 *    assertPublicUrl before following.
 * 4. Falls back to normal fetch() when the guard is disabled
 *    (APERIO_ALLOW_INTERNAL_FETCH=1) or the host is unresolvable.
 *
 * @param {string} url
 * @param {object} [options] — fetch-compatible options (headers, signal, method, body)
 * @returns {Promise<object>} — a fetch-like Response
 */
export async function safeFetch(url, options = {}, _redirectCount = 0) {
  // Guard disabled → passthrough to normal fetch.
  if (process.env.APERIO_ALLOW_INTERNAL_FETCH === "1") {
    return fetch(url, options);
  }

  const resolved = await assertPublicUrl(url);

  // No resolved addresses (guard disabled, or unresolvable host) → normal fetch.
  // Unresolvable hosts cannot rebind, so the TOCTOU risk is zero.
  if (!resolved || !resolved.addresses.length) {
    return fetch(url, options);
  }

  const { hostname, addresses } = resolved;
  const ip = addresses[0].address;
  const family = addresses[0].family;

  const parsed = new URL(url);
  const mod = parsed.protocol === "https:" ? https : http;

  const resp = await new Promise((resolve, reject) => {
    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || "GET",
      headers: {
        ...options.headers,
        Host: parsed.host,
      },
      lookup: (_hostname, _opts, cb) => cb(null, ip, family),
      signal: options.signal,
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(createResponse(res.statusCode, res.headers, Buffer.concat(chunks))));
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });

  // Manual redirect following — re-validate each Location.
  if (REDIRECT_STATUSES.has(resp.status)) {
    if (_redirectCount > 10) {
      throw new Error("SSRF guard: too many redirects");
    }
    const location = resp.headers.get("location");
    if (location) {
      const redirectUrl = new URL(location, url).toString();
      return safeFetch(redirectUrl, options, _redirectCount + 1);
    }
  }

  return resp;
}
