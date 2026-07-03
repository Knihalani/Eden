// @vitest-environment node
/**
 * Regression test for the catch-all proxy's multipart branch.
 *
 * Pre-fix: the proxy called ``request.text()`` for every request,
 * which mangled ``multipart/form-data`` payloads into a string
 * (with the binary body mangled and the boundary lost). The
 * FastAPI side then rejected every upload — agent code, avatar,
 * reference doc — as a malformed body.
 *
 * Post-fix: the proxy branches on Content-Type and reads
 * ``request.formData()`` for multipart, passing the FormData
 * object through to the upstream fetch so the boundary survives.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// Mock auth() so the handler resolves cleanly without a Clerk instance.
vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({
    getToken: async () => null,
  }),
}));

vi.mock("@/lib/proxy", async () => {
  const { NextResponse } = await import("next/server");
  return {
    forwardToBackend: vi.fn(async (path: string, opts: { body?: unknown }) => {
      // Echo what was passed so the test can inspect the body type.
      // JSON.stringify drops undefined, so encode as a string sentinel.
      const bodyType = opts.body === undefined
        ? "absent"
        : opts.body === null
          ? "null"
          : opts.body?.constructor?.name;
      return new NextResponse(
        JSON.stringify({ proxied: true, path, bodyType }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
    proxyError: vi.fn(),
  };
});

// Import the handler AFTER mocks are wired up.
import { GET, POST } from "../route";

function makeRequest(opts: {
  method?: string;
  contentType?: string;
  body?: BodyInit;
}): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.contentType) headers["Content-Type"] = opts.contentType;
  return new NextRequest("http://localhost/api/proxy/v1/test", {
    method: opts.method ?? "POST",
    headers,
    body: opts.body,
  });
}

const params = Promise.resolve({ path: ["v1", "test"] });

describe("proxy [...path] multipart handling", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("reads JSON body as text and forwards as a string", async () => {
    const req = makeRequest({
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ hello: "world" }),
    });
    const res = await POST(req, { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.path).toBe("/v1/test");
    expect(body.bodyType).toBe("String");
  });

  it("treats GET requests as body-less regardless of Content-Type", async () => {
    const req = makeRequest({ method: "GET", contentType: "application/json" });
    const res = await GET(req, { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    // GET has no body so forwardToBackend receives undefined.
    expect(body.bodyType).toBe("absent");
  });

  it("reads multipart/form-data as FormData when Content-Type indicates multipart", async () => {
    // Construct a fake request that already has a parsed FormData body
    // accessible via request.formData(). We mock the body read methods
    // so the proxy's content-type branch is exercised.
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array([1, 2, 3, 4])]), "agent.tar.gz");
    const req = new NextRequest("http://localhost/api/proxy/v1/test", {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=----test" },
    });
    // Override formData to return our prepared FormData. (NextRequest
    // reads the body during construction when Content-Type is multipart,
    // which means we can't pre-attach a body via the constructor.)
    vi.spyOn(req, "formData").mockResolvedValue(fd);
    vi.spyOn(req, "text").mockResolvedValue(""); // text() would mangle — must not be called

    const res = await POST(req, { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    // The proxy's multipart branch must call request.formData() and pass
    // the FormData through to forwardToBackend — NOT request.text().
    expect(body.bodyType).toBe("FormData");
    expect(req.text).not.toHaveBeenCalled();
  });
});
