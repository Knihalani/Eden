import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_ERRORS_ENDPOINT,
  reportClientError,
  __resetClientErrorReporterForTests,
} from "@/lib/client-error-reporter";
import { PRODUCT_VERSION } from "@/lib/constants";

async function blobJson(blob: Blob): Promise<Record<string, unknown>> {
  return JSON.parse(await blob.text()) as Record<string, unknown>;
}

describe("reportClientError", () => {
  let beacon: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetClientErrorReporterForTests();
    window.sessionStorage.clear();
    beacon = vi.fn(() => true);
    Object.defineProperty(navigator, "sendBeacon", {
      value: beacon,
      configurable: true,
      writable: true,
    });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a beacon with message, digest, boundary, route, UA, release", async () => {
    const err = Object.assign(new Error("boom"), { digest: "abc123" });
    reportClientError("portal", err);

    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, blob] = beacon.mock.calls[0] as [string, Blob];
    expect(url).toBe(CLIENT_ERRORS_ENDPOINT);
    expect(blob.type).toBe("application/json");
    const payload = await blobJson(blob);
    expect(payload.message).toBe("boom");
    expect(payload.digest).toBe("abc123");
    expect(payload.boundary).toBe("portal");
    expect(payload.route).toBe(window.location.pathname);
    expect(payload.userAgent).toBe(navigator.userAgent);
    expect(payload.release).toBe(PRODUCT_VERSION);
    expect(typeof payload.ts).toBe("string");
    expect(typeof payload.stack).toBe("string");
  });

  it("dedupes identical errors within a session", () => {
    const err = Object.assign(new Error("boom"), { digest: "same" });
    reportClientError("portal", err);
    reportClientError("portal", err);
    expect(beacon).toHaveBeenCalledTimes(1);
  });

  it("reports distinct errors separately", () => {
    reportClientError("portal", Object.assign(new Error("a"), { digest: "d1" }));
    reportClientError("portal", Object.assign(new Error("b"), { digest: "d2" }));
    expect(beacon).toHaveBeenCalledTimes(2);
  });

  it("same error in different boundaries is not deduped together", () => {
    const err = Object.assign(new Error("boom"), { digest: "same" });
    reportClientError("portal", err);
    reportClientError("global", err);
    expect(beacon).toHaveBeenCalledTimes(2);
  });

  it("falls back to keepalive fetch when sendBeacon refuses", () => {
    beacon.mockReturnValue(false);
    reportClientError("marketing", new Error("boom"));

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(CLIENT_ERRORS_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(init.keepalive).toBe(true);
    expect(init.credentials).toBe("same-origin");
  });

  it("never throws — even when sendBeacon and fetch both explode", () => {
    beacon.mockImplementation(() => {
      throw new Error("beacon down");
    });
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("net down"))));
    expect(() => reportClientError("global", new Error("boom"))).not.toThrow();
  });

  it("handles non-Error values without throwing", async () => {
    expect(() => reportClientError("portal", "string failure")).not.toThrow();
    expect(() => reportClientError("portal", null)).not.toThrow();
    expect(beacon).toHaveBeenCalledTimes(2);
    const payload = await blobJson(
      (beacon.mock.calls[0] as [string, Blob])[1],
    );
    expect(payload.message).toBe("string failure");
  });

  it("reuses one session id across reports", async () => {
    reportClientError("portal", Object.assign(new Error("a"), { digest: "d1" }));
    reportClientError("portal", Object.assign(new Error("b"), { digest: "d2" }));
    const p1 = await blobJson((beacon.mock.calls[0] as [string, Blob])[1]);
    const p2 = await blobJson((beacon.mock.calls[1] as [string, Blob])[1]);
    expect(p1.sessionId).toBeTruthy();
    expect(p1.sessionId).toBe(p2.sessionId);
  });
});
