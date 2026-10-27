/**
 * Checks for servers that listen on loopback only (`eden hookd`, `eden wrap`).
 *
 * Binding to 127.0.0.1 keeps other machines out, but not a web page open on
 * this one. A page can reach the port in two ways:
 * - a cross-site fetch, which carries the page's origin in `Origin`;
 * - DNS rebinding: the page's own hostname is re-pointed at 127.0.0.1, so the
 *   browser treats the port as same-origin. `Host` still carries the name the
 *   page asked for, so it is the header that tells the truth.
 */

const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "::1", "0:0:0:0:0:0:0:1"]);

/** A bare hostname (a bind address, or a Host value without its port) that names this machine. */
export function isLoopbackName(name: string | null | undefined): boolean {
  if (!name) return false;
  return LOOPBACK_NAMES.has(name.replace(/^\[|\]$/g, "").toLowerCase());
}

/** A `Host` header value, with or without a port, that names this machine. */
export function isLoopbackHost(host: string): boolean {
  return isLoopbackName(host.replace(/:\d+$/, ""));
}

/** A browser sent this: it carries `Origin`, or `Sec-Fetch-Site` other than "none" (a typed URL). */
export function looksBrowserDriven(req: Request): boolean {
  if (req.headers.get("origin")) return true;
  const site = req.headers.get("sec-fetch-site");
  return site !== null && site !== "none";
}

/** A page served from this machine. Anchored, so `http://localhost.evil.com` does not match. */
export function isLoopbackOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}
