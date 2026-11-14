/**
 * The API key a request carries, or "" for none. "Key-less" is decided on this, never on the header's presence:
 * `Bearer` and a no-break space parses to "" (`\s` matches it, HTTP does not trim it), and the header-presence test
 * let a rebinding page skip D351's origin check that way (the A20 review).
 */
export function keyOf(req: Request): string {
  const h = req.headers.get("authorization");
  if (h === null) return "";
  // The usual form, "Bearer " then a key that starts and ends with printable ASCII, is sliced (D1892): the regex and
  // the trim below would leave it the same. Anything else goes through them.
  const first = h.charCodeAt(7);
  const last = h.charCodeAt(h.length - 1);
  if (h.startsWith("Bearer ") && first > 0x20 && first < 0x7f && last > 0x20 && last < 0x7f) return h.slice(7);
  return h.replace(/^Bearer\s+/i, "").trim();
}
