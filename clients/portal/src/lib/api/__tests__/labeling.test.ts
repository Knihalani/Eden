// @vitest-environment jsdom
/**
 * Regression tests for the `labelingApi` client (FEAT-82/FEAT-83) —
 * confirms URL construction against `src/eden/api/routes/labeling.py`
 * and that GET query params / POST bodies are shaped as the backend
 * expects.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  // fetchApi may read `window.Clerk`; clear it without assuming jsdom
  // (plain `bun test` has no window — vitest+jsdom does).
  const g = globalThis as typeof globalThis & {
    window?: { Clerk?: unknown };
    Clerk?: unknown;
  };
  if (typeof g.window !== "undefined") {
    g.window.Clerk = undefined;
  } else {
    g.Clerk = undefined;
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function importLabelingApi() {
  const { __resetFetchApiInflightForTests } = await import("../core");
  __resetFetchApiInflightForTests();
  return (await import("../labeling")).labelingApi;
}

describe("labelingApi", () => {
  it("listQueues — GETs /orgs/{org}/labeling/queues", async () => {
    const labelingApi = await importLabelingApi();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { queues: [], total: 0 }));

    const result = await labelingApi.listQueues("org-1");

    expect(result).toEqual({ queues: [], total: 0 });
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/orgs/org-1/labeling/queues");
  });

  it("queueAgreement — GETs the /queues/{id}/agreement endpoint (renamed from /iaa)", async () => {
    const labelingApi = await importLabelingApi();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { queue_id: "q1", iaa: {} }));

    await labelingApi.queueAgreement("org-1", "q1");

    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/orgs/org-1/labeling/queues/q1/agreement");
    expect(String(url)).not.toContain("/iaa");
  });

  it("listItems — GETs /items with limit/offset query params", async () => {
    const labelingApi = await importLabelingApi();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [], total: 0 }));

    await labelingApi.listItems("org-1", { limit: 50, offset: 10 });

    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/orgs/org-1/labeling/items");
    expect(String(url)).toContain("limit=50");
    expect(String(url)).toContain("offset=10");
  });

  it("agreement — GETs /agreement, optionally filtered by item_ids", async () => {
    const labelingApi = await importLabelingApi();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        kappa: 0.5,
        alpha: 0.5,
        overall_agreement: 0.8,
        item_count: 2,
        annotation_count: 4,
        per_item: {},
        per_pair: {},
      }),
    );

    await labelingApi.agreement("org-1", ["item-a", "item-b"]);

    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/orgs/org-1/labeling/agreement");
    expect(String(url)).toContain("item_ids=item-a");
    expect(String(url)).toContain("item_ids=item-b");
  });

  it("popQueue — GETs /queue/{user_id} with a limit", async () => {
    const labelingApi = await importLabelingApi();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [] }));

    await labelingApi.popQueue("org-1", "user-9", 3);

    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/orgs/org-1/labeling/queue/user-9");
    expect(String(url)).toContain("limit=3");
  });

  it("annotate — POSTs the annotation body to /annotate", async () => {
    const labelingApi = await importLabelingApi();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        id: "ann-1",
        org_id: "org-1",
        item_id: "item-1",
        annotator_id: "user-9",
        label: "good",
        confidence: 0.9,
        notes: null,
        time_spent_ms: 1200,
        skills_exercised: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      }),
    );

    await labelingApi.annotate("org-1", {
      item_id: "item-1",
      label: "good",
      confidence: 0.9,
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/orgs/org-1/labeling/annotate");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      item_id: "item-1",
      label: "good",
      confidence: 0.9,
    });
  });

  it("skip — POSTs the item id (and optional reason) to /skip", async () => {
    const labelingApi = await importLabelingApi();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { skipped: true }));

    await labelingApi.skip("org-1", { item_id: "item-1", reason: "ambiguous" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/orgs/org-1/labeling/skip");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      item_id: "item-1",
      reason: "ambiguous",
    });
  });

  it("skipBulk — POSTs item_ids to /skip/bulk", async () => {
    const labelingApi = await importLabelingApi();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { skipped: true, skipped_count: 2 }));

    const result = await labelingApi.skipBulk("org-1", {
      item_ids: ["item-a", "item-b"],
      reason: "noise",
    });

    expect(result).toEqual({ skipped: true, skipped_count: 2 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/orgs/org-1/labeling/skip/bulk");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      item_ids: ["item-a", "item-b"],
      reason: "noise",
    });
  });

  it("propagates a non-ok response as a thrown error", async () => {
    const labelingApi = await importLabelingApi();
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { detail: "queue not found" }));

    await expect(labelingApi.listQueues("org-1")).rejects.toThrow();
  });

  it("exportJsonl — GETs /export with stream and returns plain text", async () => {
    const labelingApi = await importLabelingApi();
    fetchMock.mockResolvedValueOnce(
      new Response('{"id":"item-1"}\n', {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      }),
    );

    const body = await labelingApi.exportJsonl("org-1", {
      status: "completed",
      limit: 100,
    });

    expect(body).toBe('{"id":"item-1"}\n');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/orgs/org-1/labeling/export");
    expect(String(url)).toContain("status=completed");
    expect(String(url)).toContain("limit=100");
  });
});

describe("labelingApi listItems clamps limit (R011)", () => {
  it("sends limit=100 when the caller asks for 200", async () => {
    const labelingApi = await importLabelingApi();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [], total: 0 }));
    await labelingApi.listItems("org-1", { limit: 200 });
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("limit=100");
    expect(String(url)).not.toContain("limit=200");
  });
});
