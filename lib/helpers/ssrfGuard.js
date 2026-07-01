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
  if (process.env.APERIO_ALLOW_INTERNAL_FETCH === "1") return;

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
    return;
  }

  // Hostname — resolve and block if ANY resolved address is internal.
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    return; // unresolvable: cannot connect, so no SSRF risk
  }
  for (const { address } of addrs) {
    if (isBlockedAddress(address))
      throw new Error(`SSRF guard: "${host}" resolves to internal address ${address}.`);
  }
}
