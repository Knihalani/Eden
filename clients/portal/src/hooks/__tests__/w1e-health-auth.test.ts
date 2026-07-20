// @vitest-environment node
/**
 * W1-E — Health / outage UX: degraded Qdrant (HTTP 503) must not look
 * like session expiry; /auth/me 5xx must not clear org / force Sign in.
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/core";
import { classifyOrgLoadError } from "@/lib/org-load-error";
import { mapHealth, mapHealthResponse } from "@/lib/health-status";

describe("W1-E classifyOrgLoadError", () => {
  it("maps 401/403 to session kind that clears org", () => {
    const a = classifyOrgLoadError(new ApiError(401, "Unauthorized"));
    expect(a.kind).toBe("session");
    expect(a.clearOrg).toBe(true);
    expect(a.message).toMatch(/Session expired/i);

    const b = classifyOrgLoadError(new ApiError(403, "Forbidden"));
    expect(b.kind).toBe("session");
    expect(b.clearOrg).toBe(true);
  });

  it("maps 503 / 5xx to server kind without clearing org", () => {
    const err = classifyOrgLoadError(
      new ApiError(503, "Service Unavailable", "Backend unavailable"),
    );
    expect(err.kind).toBe("server");
    expect(err.clearOrg).toBe(false);
    expect(err.message).toMatch(/trouble reaching the server/i);
  });

  it("maps 502 to server messaging, not session expiry", () => {
    const err = classifyOrgLoadError(new ApiError(502, "Bad Gateway"));
    expect(err.kind).toBe("server");
    expect(err.clearOrg).toBe(false);
    expect(err.message).not.toMatch(/Session expired/i);
  });
});

describe("W1-E auth-brand-panel health mapping", () => {
  const degradedQdrantBody = {
    status: "degraded",
    version: "0.1.0",
    postgres: "connected",
    qdrant: "error: [Errno 99] Cannot assign requested address",
  };

  it("maps 503 + degraded body to degraded, not unknown", () => {
    expect(mapHealthResponse(503, degradedQdrantBody)).toBe("degraded");
    expect(mapHealth(degradedQdrantBody)).toBe("degraded");
  });

  it("does not fake healthy when Qdrant Errno 99 is present", () => {
    expect(mapHealth(degradedQdrantBody)).not.toBe("ok");
  });

  it("maps healthy 200 body to ok", () => {
    expect(
      mapHealthResponse(200, {
        status: "healthy",
        postgres: "connected",
        qdrant: "connected",
      }),
    ).toBe("ok");
  });

  it("maps empty 503 body to down, not unknown auth-looking state", () => {
    expect(mapHealthResponse(503, null)).toBe("down");
  });

  it("maps exact w2-07 evidence body (Qdrant Errno 99) to degraded", () => {
    // clients/portal/e2e/golden/w2-07-evidence/health_api_health.json
    const evidence = {
      status: "degraded",
      version: "0.1.0",
      postgres: "connected",
      qdrant: "error: [Errno 99] Cannot assign requested address",
      quality_worker_running: true,
      statgate_installed: true,
      evolution_loop_running: false,
    };
    expect(mapHealthResponse(503, evidence)).toBe("degraded");
    expect(mapHealthResponse(503, evidence)).not.toBe("down");
    expect(mapHealthResponse(503, evidence)).not.toBe("ok");
  });
});
