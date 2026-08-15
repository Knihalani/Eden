/**
 * Regression: dual Content-Type / content-type keys in a plain object
 * made Undici emit ``application/json, application/json``, and FastAPI
 * then treated the JSON body as a string → 422 on claim.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

describe("forwardToBackend Content-Type merge", () => {
  const originalFetch = globalThis.fetch;
  let capturedHeaders: Headers | null = null;

  beforeEach(() => {
    capturedHeaders = null;
    vi.resetModules();
    process.env.API_INTERNAL_URL = "http://upstream.test";
    process.env.NEXT_PUBLIC_API_URL = "http://upstream.test";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("does not concatenate Content-Type when extraHeaders has lowercase content-type", async () => {
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const { forwardToBackend } = await import("@/lib/proxy");
    await forwardToBackend("/orgs/abc/github/installations/claim", {
      method: "POST",
      body: JSON.stringify({ installation_id: 42 }),
      authorization: "Bearer test",
      extraHeaders: {
        "content-type": "application/json",
        accept: "application/json",
      },
    });

    expect(capturedHeaders).not.toBeNull();
    const ct = capturedHeaders!.get("content-type");
    expect(ct).toBe("application/json");
    expect(ct).not.toContain(",");
  });
});
