// @vitest-environment jsdom
/**
 * Regression test for F41-6: ``promptsV2Api.get`` used to unwrap its
 * envelope with a bare ``.then((r) => r.data)`` and no fallback,
 * unlike ``list()`` which guards with ``r.data?.prompts ?? []``. A
 * malformed/empty envelope (``{ status: "ok" }`` with no ``data``
 * key) would resolve to ``undefined`` rather than a well-typed
 * fallback, pushing the null-handling burden onto every call site.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.resetModules();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("promptsV2Api.get (F41-6)", () => {
  it("resolves to the prompt detail when the envelope is well-formed", async () => {
    const { promptsV2Api } = await import("../portal");
    fetchMock.mockResolvedValue(
      jsonResponse(200, { status: "ok", data: { name: "greeting" } }),
    );

    const result = await promptsV2Api.get("org_1", "greeting");
    expect(result).toEqual({ name: "greeting" });
  });

  it("falls back to null (never throws / undefined) when the envelope is missing its data key", async () => {
    const { promptsV2Api } = await import("../portal");
    fetchMock.mockResolvedValue(jsonResponse(200, { status: "ok" }));

    const result = await promptsV2Api.get("org_1", "missing-prompt");
    expect(result).toBeNull();
  });

  it("falls back to null when data is explicitly null", async () => {
    const { promptsV2Api } = await import("../portal");
    fetchMock.mockResolvedValue(jsonResponse(200, { status: "ok", data: null }));

    const result = await promptsV2Api.get("org_1", "missing-prompt");
    expect(result).toBeNull();
  });
});
