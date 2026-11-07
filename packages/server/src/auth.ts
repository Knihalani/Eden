/**
 * The API key a request carries, or "" for none. "Key-less" is decided on this, never on the header's presence:
 * `Bearer` and a no-break space parses to "" (`\s` matches it, HTTP does not trim it), and the header-presence test
 * let a rebinding page skip D351's origin check that way (the A20 review).
 */
export function keyOf(req: Request): string {
  return (
    req.headers
      .get("authorization")
      ?.replace(/^Bearer\s+/i, "")
      .trim() ?? ""
  );
}
