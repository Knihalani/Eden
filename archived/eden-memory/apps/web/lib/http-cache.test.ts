import { describe, expect, test } from "bun:test";
import { hasClerkSession } from "./session-cookie";
import { noneMatch, weakEtag } from "./http-cache";

function jar(entries: Record<string, string>) {
  return {
    get: (name: string) => (entries[name] != null ? { value: entries[name]! } : undefined),
  };
}

describe("hasClerkSession", () => {
  test("anonymous uat 0 is not a session", () => {
    expect(hasClerkSession(jar({ __client_uat: "0" }))).toBe(false);
  });

  test("uat timestamp is a session", () => {
    expect(hasClerkSession(jar({ __client_uat: "1710000000" }))).toBe(true);
  });

  test("empty jar is anonymous", () => {
    expect(hasClerkSession(jar({}))).toBe(false);
  });
});

describe("etag", () => {
  test("same body matches If-None-Match", () => {
    const tag = weakEtag('{"runs":1}');
    const req = new Request("http://x/api/activity", { headers: { "if-none-match": tag } });
    expect(noneMatch(req, tag)).toBe(true);
    expect(noneMatch(req, weakEtag('{"runs":2}'))).toBe(false);
  });
});
