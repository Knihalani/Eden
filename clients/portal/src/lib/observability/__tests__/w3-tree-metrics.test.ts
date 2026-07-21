/**
 * Wave 3B — tree metrics extraction + ancestor-preserving in-tree search.
 */
import { describe, expect, it } from "vitest";
import {
  buildSpanTree,
  extractSpanMetrics,
  filterSpanTreeKeepingAncestors,
  rollupTreeMetrics,
} from "@/lib/observability/build-transcript-rows";
import type { TranscriptRow } from "@/lib/observability/types";

function row(
  partial: Partial<TranscriptRow> & Pick<TranscriptRow, "span_id" | "name">,
): TranscriptRow {
  return {
    timestamp: "2026-01-01T00:00:00Z",
    duration_ms: 10,
    ...partial,
  };
}

describe("extractSpanMetrics", () => {
  it("reads input/output/cost from metrics (getTraceTree shape)", () => {
    expect(
      extractSpanMetrics({
        metrics: { input_tokens: 100, output_tokens: 40, cost_usd: 0.012 },
      }),
    ).toEqual({ input_tokens: 100, output_tokens: 40, cost_usd: 0.012 });
  });

  it("falls back to prompt/completion aliases and payload cost", () => {
    expect(
      extractSpanMetrics({
        metrics: { prompt_tokens: 8, completion_tokens: 2 },
        payload: { cost_usd: 0.001 },
      }),
    ).toEqual({ input_tokens: 8, output_tokens: 2, cost_usd: 0.001 });
  });

  it("returns nulls when fields missing (duration-only degrade)", () => {
    expect(extractSpanMetrics({ name: "tool" })).toEqual({
      input_tokens: null,
      output_tokens: null,
      cost_usd: null,
    });
  });
});

describe("rollupTreeMetrics", () => {
  it("aggregates child tokens/cost onto parent when parent lacks totals", () => {
    const tree = rollupTreeMetrics([
      row({
        span_id: "root",
        name: "agent",
        duration_ms: 200,
        children: [
          row({
            span_id: "llm",
            name: "chat",
            input_tokens: 50,
            output_tokens: 10,
            cost_usd: 0.02,
          }),
          row({ span_id: "tool", name: "bash", duration_ms: 5 }),
        ],
      }),
    ]);
    expect(tree[0]?.input_tokens).toBe(50);
    expect(tree[0]?.output_tokens).toBe(10);
    expect(tree[0]?.cost_usd).toBe(0.02);
    expect(tree[0]?.children?.[1]?.input_tokens ?? null).toBeNull();
  });

  it("keeps parent totals when already present", () => {
    const tree = rollupTreeMetrics([
      row({
        span_id: "root",
        name: "agent",
        input_tokens: 999,
        output_tokens: 1,
        cost_usd: 1,
        children: [
          row({
            span_id: "llm",
            name: "chat",
            input_tokens: 50,
            output_tokens: 10,
            cost_usd: 0.02,
          }),
        ],
      }),
    ]);
    expect(tree[0]?.input_tokens).toBe(999);
    expect(tree[0]?.cost_usd).toBe(1);
  });
});

describe("filterSpanTreeKeepingAncestors", () => {
  const roots: TranscriptRow[] = [
    row({
      span_id: "a",
      name: "root",
      children: [
        row({
          span_id: "b",
          name: "middle",
          children: [row({ span_id: "c", name: "leaf-target", event_type: "llm" })],
        }),
        row({ span_id: "d", name: "sibling", children: [row({ span_id: "e", name: "other" })] }),
      ],
    }),
  ];

  it("returns full tree when query empty", () => {
    expect(filterSpanTreeKeepingAncestors(roots, "  ")).toBe(roots);
  });

  it("keeps ancestors of name matches and drops unrelated branches", () => {
    const filtered = filterSpanTreeKeepingAncestors(roots, "leaf-target");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.span_id).toBe("a");
    expect(filtered[0]?.children).toHaveLength(1);
    expect(filtered[0]?.children?.[0]?.span_id).toBe("b");
    expect(filtered[0]?.children?.[0]?.children?.[0]?.span_id).toBe("c");
  });

  it("matches span_id and event_type", () => {
    expect(filterSpanTreeKeepingAncestors(roots, "llm")[0]?.children?.[0]?.children?.[0]?.name).toBe(
      "leaf-target",
    );
    const byId = filterSpanTreeKeepingAncestors(roots, "span-unique");
    expect(byId).toHaveLength(0);
    const withId = [
      row({
        span_id: "root2",
        name: "r",
        children: [row({ span_id: "abc-unique-xyz", name: "n" })],
      }),
    ];
    expect(filterSpanTreeKeepingAncestors(withId, "abc-unique")[0]?.children?.[0]?.span_id).toBe(
      "abc-unique-xyz",
    );
  });
});

describe("buildSpanTree metrics", () => {
  it("maps tree payload metrics onto TranscriptRow and rolls up", () => {
    const tree = buildSpanTree([
      {
        span_id: "root",
        name: "agent",
        duration_ms: 100,
        timestamp: "2026-01-01T00:00:00Z",
        children: [
          {
            span_id: "gen",
            name: "generation",
            duration_ms: 80,
            timestamp: "2026-01-01T00:00:01Z",
            metrics: { input_tokens: 12, output_tokens: 4, cost_usd: 0.005 },
            children: [],
          },
        ],
      },
    ]);
    expect(tree[0]?.children?.[0]?.input_tokens).toBe(12);
    expect(tree[0]?.children?.[0]?.cost_usd).toBe(0.005);
    expect(tree[0]?.input_tokens).toBe(12);
    expect(tree[0]?.cost_usd).toBe(0.005);
  });
});
