// @vitest-environment jsdom
/**
 * FEAT-174 — `labelingApi` in resources.ts matches backend
 * `ItemResponse` / `AnnotationResponse` / `AnnotateRequest` shapes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AnnotateRequestBody,
  AnnotationResponse,
  LabelingItem,
  LabelingItemListEntry,
} from "../resources";

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

async function importResourcesLabelingApi() {
  const { __resetFetchApiInflightForTests } = await import("../core");
  __resetFetchApiInflightForTests();
  const { labelingApi } = await import("../resources");
  return labelingApi;
}

/** Compile-time guard: annotate body accepts optional backend fields. */
const _annotateBody: AnnotateRequestBody = {
  item_id: "item-1",
  label: { rating: 4 },
  confidence: 0.75,
  notes: null,
  time_spent_ms: 900,
  skills_exercised: ["classification"],
};
void _annotateBody;

describe("resources labelingApi (FEAT-174)", () => {
  it("listItems — typed as LabelingItemListEntry rows, not full ItemResponse", async () => {
    const labelingApi = await importResourcesLabelingApi();
    const listRow: LabelingItemListEntry = {
      id: "item-1",
      prompt: "Rate this",
      context: null,
      tags: ["qa"],
      source: "seed",
      created_at: "2026-01-01T00:00:00Z",
      annotations_count: 0,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [listRow], total: 1 }));

    const result = await labelingApi.listItems("org-1");

    expect(result.items[0]).toEqual(listRow);
    expect(result.items[0]).not.toHaveProperty("payload");
  });

  it("annotate — POSTs confidence, time_spent_ms, and skills_exercised", async () => {
    const labelingApi = await importResourcesLabelingApi();
    const annotation: AnnotationResponse = {
      id: "ann-1",
      org_id: "org-1",
      item_id: "item-1",
      annotator_id: "user-9",
      label: { rating: 4 },
      confidence: 0.8,
      notes: "clear",
      time_spent_ms: 1500,
      skills_exercised: ["classification"],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, annotation));

    const body: AnnotateRequestBody = {
      item_id: "item-1",
      label: { rating: 4 },
      confidence: 0.8,
      time_spent_ms: 1500,
      skills_exercised: ["classification"],
      notes: "clear",
    };
    const result = await labelingApi.annotate("org-1", body);

    expect(result).toEqual(annotation);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual(body);
  });

  it("seedItem — returns item_id envelope, not a full LabelingItem", async () => {
    const labelingApi = await importResourcesLabelingApi();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { item_id: "item-new" }));

    const result = await labelingApi.seedItem("org-1", { prompt: "hello", tags: ["t"] });

    expect(result).toEqual({ item_id: "item-new" });
    const fullItem: LabelingItem = {
      id: "item-new",
      org_id: "org-1",
      payload: {},
      label_schema: {},
      prompt: "hello",
      status: "pending",
      tags: ["t"],
      annotations_required: 1,
      required_skills: [],
      source_trace_id: null,
      source_span_id: null,
      source_dataset_id: null,
      source_synthetic_qa_id: null,
      assigned_to: null,
    };
    expect(result).not.toEqual(fullItem);
  });

  it("re-exports popQueue and exportJsonl from labeling.ts", async () => {
    const labelingApi = await importResourcesLabelingApi();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [] }));

    await labelingApi.popQueue("org-1", "user-9", 2);

    const [popUrl] = fetchMock.mock.calls[0]!;
    expect(String(popUrl)).toContain("/orgs/org-1/labeling/queue/user-9");

    fetchMock.mockResolvedValueOnce(
      new Response("{}\n", {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      }),
    );

    const body = await labelingApi.exportJsonl("org-1");
    expect(body).toBe("{}\n");
    const [exportUrl] = fetchMock.mock.calls[1]!;
    expect(String(exportUrl)).toContain("/orgs/org-1/labeling/export");
  });
});
