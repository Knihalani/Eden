import { afterAll, describe, expect, test } from "bun:test";
import { buildPartner } from "./build";
import { createHandler } from "./http";
import { StaticSource } from "@eden/sources";

// Audit A20 (security). Dev mode (EDEN_DEV=1, the README's quickstart, with real sources) serves requests with no key.
// A web page the developer visits can reach 127.0.0.1:8790: by DNS rebinding (its own hostname re-pointed at
// 127.0.0.1, so the page reads the answers as same-origin) or as a blind cross-site POST (a text/plain body is parsed
// all the same). Every browser POST carries an Origin header and no agent's HTTP client sends one, so a keyless request
// from a foreign origin is refused; a page on this machine (localhost, 127.0.0.1, [::1]) is still served.
const sources = new StaticSource("calendar", "The user's calendar", [
  { ref: "evt-1", title: "Board meeting with Priya", text: "Thursday 10:00, acquisition terms, confidential" },
]);
const partner = buildPartner({ sources: async () => [sources], model: null });
afterAll(() => partner.stopSync());
const dev = createHandler(partner, { keys: new Map(), dev: true });
const keyed = createHandler(partner, { keys: new Map([["k_0123456789abcdef", "acme"]]), dev: true });
const ask = (headers: Record<string, string>) =>
  new Request("http://127.0.0.1:8790/v1/ask", {
    method: "POST",
    headers: { "content-type": "text/plain", ...headers },
    body: JSON.stringify({ userId: "me", sessionId: "s1", question: "When is the board meeting with Priya?" }),
  });

describe("audit A20: keyless (dev) requests from a browser on another origin are refused", () => {
  test.each(["http://evil.example:8790", "https://attacker.test", "null"])("Origin %s gets a 403", async (origin) => {
    const res = await dev(ask({ origin }));
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain("acquisition");
  });
  test.each(["http://localhost:3000", "http://127.0.0.1:8790", "http://[::1]:5173"])(
    "a page on this machine (%s) is served",
    async (origin) => {
      expect((await dev(ask({ origin }))).status).toBe(200);
    },
  );
  test("an agent's client (no Origin) is served", async () => {
    expect((await dev(ask({}))).status).toBe(200);
  });
  test("a keyed request is unaffected: the key is the check", async () => {
    const res = await keyed(ask({ origin: "https://app.example", authorization: "Bearer k_0123456789abcdef" }));
    expect(res.status).toBe(200);
  });
});
