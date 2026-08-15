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
 * Regression test for FEAT-32 / FEAT-38: ``portalApi.guardrailPolicies``
 * maps the portal read-model cards from
 * ``GET /orgs/{org}/portal/guardrails/policies`` (bare
 * ``GuardrailPolicyCard[]``, not the intelligence ``GuardrailPolicy.list``
 * ok-envelope). ``matchCount24h`` is sourced from ``intervention_log``
 * (InterventionEngine path only).
 */
describe("portalApi.guardrailPolicies (FEAT-32 / FEAT-38)", () => {
  it("maps portal policy cards including matchCount24h from intervention_log", async () => {
    const { portalApi } = await import("../portal");
    fetchMock.mockResolvedValue(
      jsonResponse(200, [
        {
          id: "gp_1",
          name: "block-ssn",
          kind: "pii_redaction",
          status: "active",
          agentId: "agt_1",
          severity: "high",
          matchCount24h: 3,
          action: "redact",
        },
        {
          id: "gp_2",
          name: "off-policy",
          kind: "content_policy",
          status: "disabled",
          action: "flag",
        },
      ]),
    );

    const result = await portalApi.guardrailPolicies("org_1");
    expect(result).toEqual([
      {
        id: "gp_1",
        name: "block-ssn",
        kind: "pii_redaction",
        status: "active",
        action: "redact",
        agentId: "agt_1",
        severity: "high",
        matchCount24h: 3,
      },
      {
        id: "gp_2",
        name: "off-policy",
        kind: "content_policy",
        status: "disabled",
        action: "flag",
      },
    ]);
  });

  it("resolves to an empty array (never throws) when the response is not an array", async () => {
    const { portalApi } = await import("../portal");
    fetchMock.mockResolvedValue(jsonResponse(200, { status: "ok" }));

    const result = await portalApi.guardrailPolicies("org_1");
    expect(result).toEqual([]);
  });
});

/**
 * FEAT-110 — ``portalApi.verifyAuditChain`` calls the live compliance
 * ``POST /orgs/{org}/compliance/verify`` route (not the portal read-model).
 */
describe("portalApi.verifyAuditChain (FEAT-110)", () => {
  it("POSTs to /compliance/verify and returns the ok-envelope", async () => {
    const { portalApi } = await import("../portal");
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        status: "ok",
        feature: "agent_audit_ledger_verify",
        live: true,
        data: {
          verified: true,
          total_rows: 3,
          ok_rows: 3,
          broken_rows: 0,
        },
      }),
    );

    const result = await portalApi.verifyAuditChain("org_1", {
      agentId: "agent-a",
      limit: 50,
    });

    expect(result.data?.verified).toBe(true);
    expect(result.data?.ok_rows).toBe(3);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/orgs/org_1/compliance/verify");
    expect(String(url)).toContain("agent_id=agent-a");
    expect(String(url)).toContain("limit=50");
    expect(init?.method).toBe("POST");
  });
});
