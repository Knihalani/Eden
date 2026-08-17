/**
 * Egress guard for playback.
 *
 * Compiled tools carry URLs that were mined from recorded traffic, and /v1/play
 * fetches them from the server. That makes every compiled step a potential
 * request forgery into whatever the server can reach, so a URL has to clear
 * three checks rather than one:
 *
 *   1. the scheme is http(s),
 *   2. the host does not name a private, loopback or metadata address — in any
 *      of the notations that resolve to one,
 *   3. the names it actually resolves to are public too.
 *
 * (3) matters because a public hostname is free to have an A record pointing at
 * 127.0.0.1; checking the literal alone stops nothing. A determined attacker can
 * still re-point DNS between our lookup and the connection (rebinding), which
 * needs connection-level pinning to close properly — this narrows the hole a
 * long way without that machinery.
 *
 * Redirects are handled by safeFetch(): fetch() follows them by default, so a
 * permitted host answering `302 -> http://169.254.169.254/` would sail straight
 * past a check performed only on the original URL.
 */
import { lookup } from "node:dns/promises";

const BLOCKED_SUFFIXES = [".internal", ".local", ".localhost", ".home.arpa"];
const BLOCKED_NAMES = new Set(["localhost", "metadata.google.internal", "metadata", "instance-data"]);

/** Parses the dotted-quad, integer, octal and hex forms `URL` accepts. */
export function parseIpv4(host: string): number | null {
  const parts = host.split(".");
  if (parts.length > 4 || parts.length === 0) return null;
  const nums: number[] = [];
  for (const raw of parts) {
    if (!raw) return null;
    let n: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(raw)) n = parseInt(raw, 16);
    else if (/^0[0-7]+$/.test(raw)) n = parseInt(raw, 8);
    else if (/^[0-9]+$/.test(raw)) n = parseInt(raw, 10);
    else return null;
    if (!Number.isSafeInteger(n) || n < 0) return null;
    nums.push(n);
  }
  // `a.b.c.d`, but also the short forms: `a` (32 bits), `a.b` (8 + 24), `a.b.c`.
  const last = nums[nums.length - 1]!;
  const leading = nums.slice(0, -1);
  if (leading.some((n) => n > 255)) return null;
  const rest = 4 - leading.length;
  if (last >= 2 ** (8 * rest)) return null;
  let value = last;
  for (let i = 0; i < leading.length; i++) {
    value += leading[i]! * 2 ** (8 * (3 - i));
  }
  return value >>> 0;
}

function ipv4Blocked(value: number): boolean {
  const inRange = (cidr: string, bits: number) => {
    const base = parseIpv4(cidr)!;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) >>> 0 === (base & mask) >>> 0;
  };
  return (
    inRange("0.0.0.0", 8) || // "this network"
    inRange("10.0.0.0", 8) || // RFC1918
    inRange("100.64.0.0", 10) || // CGNAT
    inRange("127.0.0.0", 8) || // loopback
    inRange("169.254.0.0", 16) || // link-local, incl. cloud metadata
    inRange("172.16.0.0", 12) || // RFC1918
    inRange("192.0.0.0", 24) || // IETF protocol assignments
    inRange("192.0.2.0", 24) || // TEST-NET-1
    inRange("192.168.0.0", 16) || // RFC1918
    inRange("198.18.0.0", 15) || // benchmarking
    inRange("198.51.100.0", 24) || // TEST-NET-2
    inRange("203.0.113.0", 24) || // TEST-NET-3
    inRange("224.0.0.0", 4) || // multicast
    inRange("240.0.0.0", 4) // reserved, incl. 255.255.255.255
  );
}

function ipv6Blocked(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::" || h === "::1") return true;
  // IPv4-mapped (::ffff:127.0.0.1) and IPv4-compatible forms defer to the v4 rules.
  const mapped = h.match(/^::(?:ffff:)?((?:\d{1,3}\.){3}\d{1,3})$/);
  if (mapped) {
    const v4 = parseIpv4(mapped[1]!);
    return v4 === null || ipv4Blocked(v4);
  }
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // fc00::/7 unique-local
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // fe80::/10 link-local
  return false;
}

/** True if this host literal names an address we must never fetch. */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
  if (!h) return true;
  if (BLOCKED_NAMES.has(h)) return true;
  if (BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) return true;
  if (h.includes(":")) return ipv6Blocked(h);
  const v4 = parseIpv4(h);
  if (v4 !== null) return ipv4Blocked(v4);
  return false;
}

/** True if every address `hostname` resolves to is publicly routable. */
export async function resolvesToPublicAddress(hostname: string): Promise<boolean> {
  const h = hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (isBlockedHost(h)) return false;
  // A literal needs no lookup, and asking for one would only add a failure mode.
  if (h.includes(":") || parseIpv4(h) !== null) return true;
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await lookup(h, { all: true });
  } catch {
    return false; // unresolvable: fail closed
  }
  if (!addrs.length) return false;
  return addrs.every((a) => !isBlockedHost(a.address));
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

export async function checkEgressUrl(raw: string): Promise<UrlCheck> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "malformed url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `blocked url scheme ${url.protocol}` };
  }
  if (isBlockedHost(url.hostname)) return { ok: false, reason: `blocked host ${url.hostname}` };
  if (!(await resolvesToPublicAddress(url.hostname))) {
    return { ok: false, reason: `host resolves to a non-public address: ${url.hostname}` };
  }
  return { ok: true, url };
}

export type SafeFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * fetch(), with every redirect hop re-checked against the egress rules.
 *
 * `redirect: "manual"` is the point of this: the default "follow" would let a
 * permitted host hand us a Location pointing anywhere it liked.
 */
export async function safeFetch(
  url: string,
  init: RequestInit,
  opts: { maxRedirects?: number; fetchImpl?: typeof fetch } = {},
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const doFetch = opts.fetchImpl ?? fetch;
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const check = await checkEgressUrl(current);
    if (!check.ok) throw new Error(check.reason);
    const res = await doFetch(current, { ...init, redirect: "manual" });
    if (res.status < 300 || res.status > 399) return res;
    const location = res.headers.get("location");
    if (!location) return res;
    current = new URL(location, current).href;
  }
  throw new Error(`too many redirects (>${maxRedirects})`);
}
