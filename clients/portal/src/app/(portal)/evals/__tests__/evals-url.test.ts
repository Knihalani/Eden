import { describe, expect, it } from "vitest";
import {
  clearEvalsSelection,
  normalizeEvalsSearchParams,
  parseEvalsSearchParams,
  parseEvalsTab,
  writeEvalsSearchParams,
} from "@/lib/evals-url";

describe("evals-url", () => {
  it("parseEvalsTab defaults and accepts known tabs", () => {
    expect(parseEvalsTab(undefined)).toBe("datasets");
    expect(parseEvalsTab("bogus")).toBe("datasets");
    expect(parseEvalsTab("playgrounds")).toBe("playgrounds");
    expect(parseEvalsTab("eval")).toBe("eval");
  });

  it("parseEvalsSearchParams reads aliases and enums", () => {
    const params = new URLSearchParams({
      tab: "experiments",
      dataset_id: "ds_1",
      baseline_id: "exp_a",
      compareId: "exp_b",
      layout: "grid",
      diff: "1",
      grade: "regress",
      promote_trace: "tr_9",
      q: "refund",
    });
    const state = parseEvalsSearchParams(params);
    expect(state.tab).toBe("experiments");
    expect(state.datasetId).toBe("ds_1");
    expect(state.baselineId).toBe("exp_a");
    expect(state.compareId).toBe("exp_b");
    expect(state.layout).toBe("grid");
    expect(state.diff).toBe("1");
    expect(state.grade).toBe("regress");
    expect(state.traceId).toBe("tr_9");
    expect(state.q).toBe("refund");
  });

  it("normalizeEvalsSearchParams canonicalizes aliases and drops defaults", () => {
    const raw = new URLSearchParams({
      tab: "datasets",
      dataset_id: "ds_1",
      layout: "summary",
      diff: "0",
      grade: "nope",
    });
    const next = normalizeEvalsSearchParams(raw);
    expect(next.get("tab")).toBeNull();
    expect(next.get("datasetId")).toBe("ds_1");
    expect(next.get("dataset_id")).toBeNull();
    expect(next.get("layout")).toBeNull();
    expect(next.get("diff")).toBeNull();
    expect(next.get("grade")).toBeNull();
  });

  it("writeEvalsSearchParams patches over a base", () => {
    const base = new URLSearchParams({
      tab: "playgrounds",
      q: "x",
      datasetId: "keep-me",
    });
    const next = writeEvalsSearchParams(
      { tab: "experiments", q: undefined, experimentId: "exp_1" },
      base,
    );
    expect(next.get("tab")).toBe("experiments");
    expect(next.get("q")).toBeNull();
    expect(next.get("experimentId")).toBe("exp_1");
    expect(next.get("datasetId")).toBe("keep-me");
  });

  it("clearEvalsSelection drops ids but keeps tab/filters/compare", () => {
    const params = new URLSearchParams({
      tab: "experiments",
      datasetId: "ds_1",
      playgroundId: "pg_1",
      experimentId: "exp_1",
      queueId: "q_1",
      traceId: "tr_1",
      spanId: "sp_1",
      baselineId: "exp_a",
      compareId: "exp_b",
      grade: "regress",
      q: "keep",
      filter: "keep-filter",
    });
    const next = clearEvalsSelection(params);
    expect(next.get("datasetId")).toBeNull();
    expect(next.get("playgroundId")).toBeNull();
    expect(next.get("experimentId")).toBeNull();
    expect(next.get("queueId")).toBeNull();
    expect(next.get("traceId")).toBeNull();
    expect(next.get("spanId")).toBeNull();
    expect(next.get("tab")).toBe("experiments");
    expect(next.get("baselineId")).toBe("exp_a");
    expect(next.get("compareId")).toBe("exp_b");
    expect(next.get("grade")).toBe("regress");
    expect(next.get("q")).toBe("keep");
    expect(next.get("filter")).toBe("keep-filter");
  });
});
