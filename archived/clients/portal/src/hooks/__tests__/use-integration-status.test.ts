// @vitest-environment jsdom
/**
 * Regression test for F41-4: the "storage" integration probe used to
 * bypass ``fetchApi`` entirely via a hand-rolled ``fetch()`` call,
 * missing the shared auth-bearer-attach/timeout/retry pipeline. It
 * now routes through ``fetchApi``'s ``raw`` mode (still gets the
 * shared pipeline, still gets the live ``Response`` back to branch
 * on status).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const { fetchApiMock } = vi.hoisted(() => ({ fetchApiMock: vi.fn() }));

vi.mock("@/lib/api/core", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/core")>(
    "@/lib/api/core",
  );
  return { ...actual, fetchApi: fetchApiMock };
});

import { useIntegrationStatus } from "../use-integration-status";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  fetchApiMock.mockReset();
});

describe("useIntegrationStatus('storage') raw-mode migration (F41-4)", () => {
  it("routes the probe through fetchApi's raw mode instead of a bare fetch()", async () => {
    fetchApiMock.mockResolvedValue(jsonResponse(200, {}));

    const { result } = renderHook(() => useIntegrationStatus("storage"));

    await waitFor(() => expect(result.current.status).toBe("available"));

    expect(fetchApiMock).toHaveBeenCalledWith(
      "/auth/users/me/avatar",
      expect.objectContaining({ method: "POST", raw: true }),
    );
  });

  it("surfaces a 503 (not configured) as unavailable with the upstream detail message", async () => {
    fetchApiMock.mockResolvedValue(
      jsonResponse(503, { detail: "Storage backend not configured." }),
    );

    const { result } = renderHook(() => useIntegrationStatus("storage"));

    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current.message).toBe("Storage backend not configured.");
  });

  it("surfaces a 5xx as unavailable with a generic retry message", async () => {
    fetchApiMock.mockResolvedValue(jsonResponse(500, {}));

    const { result } = renderHook(() => useIntegrationStatus("storage"));

    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current.message).toMatch(/Try again/i);
  });
});
