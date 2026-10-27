import { test, expect, describe, afterAll } from "bun:test";
import { Store } from "./store";
import { createHandler } from "./server";

// Org binding: a DATABASE_URL in .env makes the control plane treat itself as
// managed, which would refuse this file's deliberate "eden_dev" handler.
// Same pin as golden.test.ts.
const PREV_DEV = process.env.EDEN_DEV;
process.env.EDEN_DEV = "1";
afterAll(() => {
  if (PREV_DEV === undefined) delete process.env.EDEN_DEV;
  else process.env.EDEN_DEV = PREV_DEV;
});

/**
 * The preflight branch in `server.ts` and the ~39 `return json(...)` exits in
 * `api.ts` used to disagree. `json()` takes the request as an optional third
 * argument and only one call site ever passed it, so every success response was
 * built with `corsFor(undefined)`: `vary: origin` and no
 * `access-control-allow-origin`. The browser-visible symptom was backwards from
 * the usual CORS failure — the preflight succeeded, the real 200 was
 * unreadable, and the 401 was the only reply the page could actually see.
 *
 * These tests pin both halves: allowed origins must be echoed on *every*
 * response, and the allowlist must stay anchored so a lookalike host cannot
 * borrow it.
 */
const handler = () => createHandler({ store: new Store(":memory:"), token: "eden_dev" });
const ALLOWED = "http://localhost:3000";
const auth = { authorization: "Bearer eden_dev" };

describe("cors", () => {
  test("an allowed origin is echoed on success, not only on the error", async () => {
    const h = handler();
    const pre = await h(new Request("http://x/v1/stats", { method: "OPTIONS", headers: { origin: ALLOWED } }));
    const ok = await h(new Request("http://x/v1/stats", { headers: { origin: ALLOWED, ...auth } }));
    const denied = await h(new Request("http://x/v1/stats", { headers: { origin: ALLOWED } }));

    expect(pre.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    // The regression: this was `null` while the preflight above said yes.
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    expect(ok.headers.get("cache-control")).toMatch(/no-store/);
    expect(denied.status).toBe(401);
    expect(denied.headers.get("access-control-allow-origin")).toBe(ALLOWED);
  });

  test("a 404 is readable cross-origin too", async () => {
    const res = await handler()(new Request("http://x/v1/does-not-exist", { headers: { origin: ALLOWED, ...auth } }));
    expect(res.status).toBe(404);
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED);
  });

  test("the allowlist stays anchored and never wildcards", async () => {
    const h = handler();
    const hostile = [
      "https://evil.example",
      "http://localhost.evil.com",
      "http://127.0.0.1.evil.com",
      "http://evil.com/localhost",
      "null",
    ];
    for (const origin of hostile) {
      const res = await h(new Request("http://x/v1/stats", { headers: { origin, ...auth } }));
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
      expect(res.headers.get("vary")).toBe("origin");
    }
  });

  test("a request with no origin gets no allow-origin header", async () => {
    const res = await handler()(new Request("http://x/v1/stats", { headers: auth }));
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("the response body survives the header stamping", async () => {
    const res = await handler()(new Request("http://x/v1/stats", { headers: { origin: ALLOWED, ...auth } }));
    expect(await res.json()).toBeTruthy();
  });
});
