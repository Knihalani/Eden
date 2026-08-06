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

/**
 * Regression test for FEAT-32: ``portalApi.guardrailPolicies`` used to be
 * typed ``fetchApi<GuardrailPolicyFixture[]>``, but
 * ``GuardrailPolicy.list`` (``eden/guardrails/policy.py``) wraps rows in
 * the standard ok-envelope ``{status, feature, live, timestamp, data:
 * {policies, count}}``. Any real, non-empty response was an envelope
 * object rather than the array the page assumed, and the bug only hid
 * because the zero-policy fixture fallback happened to also be an empty
 * array.
 */
describe("portalApi.guardrailPolicies (FEAT-32)", () => {
  it("unwraps data.policies and maps each row's `type` onto `kind`", async () => {
    const { portalApi } = await import("../portal");
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        status: "ok",
        feature: "guardrail_policy",
        live: true,
        timestamp: "2026-01-01T00:00:00Z",
        data: {
          policies: [
            {
              id: "gp_1",
              org_id: "org_1",
              name: "block-ssn",
              type: "pii_redaction",
              spec: { patterns: ["ssn"] },
              action: "redact",
              direction: "both",
              status: "active",
              created_at: "2026-01-01T00:00:00Z",
            },
          ],
          count: 1,
        },
      }),
    );

    const result = await portalApi.guardrailPolicies("org_1");
    expect(result).toEqual([
      {
        id: "gp_1",
        name: "block-ssn",
        kind: "pii_redaction",
        status: "active",
        action: "redact",
      },
    ]);
  });

  it("resolves to an empty array (never throws) when data is missing", async () => {
    const { portalApi } = await import("../portal");
    fetchMock.mockResolvedValue(jsonResponse(200, { status: "ok" }));

    const result = await portalApi.guardrailPolicies("org_1");
    expect(result).toEqual([]);
  });
});
