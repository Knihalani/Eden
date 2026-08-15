// @vitest-environment jsdom
/**
 * Wave 9 — TraceDiffDialog calls portalApi.traceDiff and renders the
 * aligned per-step diff (kinds, deltas, filter chips) or an error.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const traceDiff = vi.fn();

vi.mock("@/lib/api/portal", () => ({
  portalApi: {
    traceDiff: (...args: unknown[]) => traceDiff(...args),
  },
}));

vi.mock("@/lib/lab-toast", () => ({
  useLabToast: () => ({ pushToast: vi.fn() }),
}));

import { TraceDiffDialog } from "./trace-diff-dialog";
import type { TraceDiffResult } from "@/lib/api/portal";

const RESULT: TraceDiffResult = {
  trace_a: {
    trace_id: "tr_a",
    span_count: 3,
    duration_ms: 1200,
    cost_usd: 0.012,
    failures: 1,
    input_tokens: 100,
    output_tokens: 50,
  },
  trace_b: {
    trace_id: "tr_b",
    span_count: 4,
    duration_ms: 900,
    cost_usd: 0.008,
    failures: 0,
    input_tokens: 80,
    output_tokens: 40,
  },
  totals: {
    cost_delta_usd: -0.004,
    duration_delta_ms: -300,
    span_count_delta: 1,
    failures_a: 1,
    failures_b: 0,
    token_delta: -30,
  },
  shared: { agent_id: "agent-1", matched_spans: 2 },
  counts: { same: 1, changed: 1, added: 1, removed: 0 },
  steps: [
    {
      index: 0,
      kind: "same",
      span_id: "span-1",
      name_a: "plan",
      name_b: "plan",
      event_type_a: "plan",
      event_type_b: "plan",
      outcome_a: "success",
      outcome_b: "success",
      error_a: null,
      error_b: null,
      duration_ms_a: 500,
      duration_ms_b: 510,
      duration_delta_ms: 10,
      cost_usd_a: 0.002,
      cost_usd_b: 0.002,
    },
    {
      index: 1,
      kind: "changed",
      span_id: "span-2",
      name_a: "generate",
      name_b: "generate-v2",
      event_type_a: "llm",
      event_type_b: "llm",
      outcome_a: "success",
      outcome_b: "error",
      error_a: null,
      error_b: "rate_limit",
      duration_ms_a: 400,
      duration_ms_b: 200,
      duration_delta_ms: -200,
      cost_usd_a: 0.006,
      cost_usd_b: 0.004,
    },
    {
      index: 2,
      kind: "only_b",
      span_id: "span-3",
      name_a: null,
      name_b: "retry",
      event_type_a: null,
      event_type_b: "tool_call",
      outcome_a: null,
      outcome_b: "success",
      error_a: null,
      error_b: null,
      duration_ms_a: 0,
      duration_ms_b: 190,
      duration_delta_ms: 190,
      cost_usd_a: 0,
      cost_usd_b: 0.002,
    },
  ],
  took_ms: 1.2,
};

describe("TraceDiffDialog (Wave 9)", () => {
  beforeEach(() => {
    traceDiff.mockReset();
  });

  it("renders when open and closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <TraceDiffDialog
        open
        onClose={onClose}
        orgId="org-1"
        traceId="tr_a"
        traceName="My run"
      />,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Compare runs" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("calls portalApi.traceDiff with both ids and renders summary + steps", async () => {
    traceDiff.mockResolvedValueOnce(RESULT);
    render(
      <TraceDiffDialog
        open
        onClose={vi.fn()}
        orgId="org-1"
        traceId="tr_a"
        candidates={[{ id: "tr_b", name: "Baseline run" }]}
      />,
    );

    // Dialog opens with the first candidate pre-selected.
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));

    await waitFor(() => {
      expect(traceDiff).toHaveBeenCalledWith("org-1", "tr_a", "tr_b");
    });

    // Aggregate deltas + step kinds render once the result lands.
    expect(await screen.findByText("generate-v2")).toBeTruthy();
    expect(screen.getByText("Cost")).toBeTruthy();
    // Negative deltas format as sign + magnitude (no double minus,
    // no "$−0.004" sign-after-currency bug): cost −$0.004, duration −300ms.
    expect(screen.getByText("−$0.004000")).toBeTruthy();
    expect(screen.getByText("−300ms")).toBeTruthy();
    // Step kinds rendered.
    expect(screen.getByText("Same")).toBeTruthy();
    expect(screen.getByText("Changed")).toBeTruthy();
    expect(screen.getByText("Added")).toBeTruthy();
    // The changed step's new name and error outcome are visible.
    expect(screen.getByText("generate-v2")).toBeTruthy();
  });

  it("filters steps by kind", async () => {
    traceDiff.mockResolvedValueOnce(RESULT);
    render(
      <TraceDiffDialog
        open
        onClose={vi.fn()}
        orgId="org-1"
        traceId="tr_a"
        candidates={[{ id: "tr_b", name: "Baseline run" }]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    await screen.findByText("generate-v2");

    fireEvent.click(screen.getByRole("button", { name: "Same · 1" }));
    expect(screen.queryByText("generate-v2")).toBeNull();
    expect(screen.getByText("plan")).toBeTruthy();
  });

  it("shows an error when the diff call fails", async () => {
    traceDiff.mockRejectedValueOnce(new Error("One or both traces not found"));
    render(
      <TraceDiffDialog
        open
        onClose={vi.fn()}
        orgId="org-1"
        traceId="tr_a"
        candidates={[{ id: "tr_missing", name: "Gone" }]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "One or both traces not found",
    );
  });

  it("keeps the result across parent re-renders (fresh candidates array)", async () => {
    traceDiff.mockResolvedValueOnce(RESULT);
    const onClose = vi.fn();
    const props = {
      open: true,
      onClose,
      orgId: "org-1",
      traceId: "tr_a",
      candidates: [{ id: "tr_b", name: "Baseline run" }],
    };
    const { rerender } = render(<TraceDiffDialog {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    await screen.findByText("generate-v2");

    // Parent re-render passes a NEW candidates array reference — the
    // diff result must NOT be wiped by the reset effect.
    rerender(
      <TraceDiffDialog
        {...props}
        candidates={[{ id: "tr_b", name: "Baseline run" }]}
      />,
    );
    expect(screen.getByText("generate-v2")).toBeTruthy();
    expect(screen.getByText("Cost")).toBeTruthy();
  });

  it("pre-selects prefillTraceId for one-click compare-to-previous", async () => {
    traceDiff.mockResolvedValueOnce(RESULT);
    render(
      <TraceDiffDialog
        open
        onClose={vi.fn()}
        orgId="org-1"
        traceId="tr_a"
        candidates={[{ id: "tr_b", name: "Baseline run" }]}
        prefillTraceId="tr_prev"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    await waitFor(() => {
      expect(traceDiff).toHaveBeenCalledWith("org-1", "tr_a", "tr_prev");
    });
  });

  it("does not compare the run against itself", () => {
    render(
      <TraceDiffDialog
        open
        onClose={vi.fn()}
        orgId="org-1"
        traceId="tr_a"
        candidates={[{ id: "tr_a", name: "Same run" }]}
      />,
    );
    // Only candidate equals the primary run → the input is empty and the
    // Compare button is disabled.
    const btn = screen.getByRole("button", { name: "Compare" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(traceDiff).not.toHaveBeenCalled();
  });
});
