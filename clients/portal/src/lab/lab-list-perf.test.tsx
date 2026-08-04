/**
 * Guards the two list-performance properties the traces surfaces rely
 * on. Both are *measurements*, not shape assertions:
 *
 *  1. The transcript is virtualised — a 5,000-span trace must mount a
 *     bounded number of rows, not 5,000.
 *  2. `RunListButton`'s memo actually prevents re-renders. A memo whose
 *     props change identity every render is a no-op, so the test counts
 *     real row renders (one `formatDuration` call per row render) across
 *     a selection change, and contrasts the stable-callback contract
 *     against the inline-closure form that used to be in the page.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { useCallback, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TraceFixture, TranscriptStep } from "@/lab/fixtures/traces";

vi.mock("@/lab/fixtures/traces", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lab/fixtures/traces")>();
  return { ...actual, formatDuration: vi.fn(actual.formatDuration) };
});

const { formatDuration } = await import("@/lab/fixtures/traces");
const { RunListButton, RunTranscript } = await import("@/lab/lab-ui");

const renderCount = () => vi.mocked(formatDuration).mock.calls.length;

function makeTrace(i: number): TraceFixture {
  return {
    id: `t${i}`,
    agentId: "agent_1",
    name: `Run ${i}`,
    status: "ok",
    startedAt: "2026-07-27T00:00:00Z",
    durationMs: 100,
    tokens: 10,
    costUsd: 0.01,
    severity: "none",
    signals: { title: "", body: "" },
    steps: [],
  };
}

const ROWS = 50;
const TRACES = Array.from({ length: ROWS }, (_, i) => makeTrace(i));

/** `stable: false` reproduces the pre-fix `onSelect={() => select(id)}`. */
function Harness({ stable }: { stable: boolean }) {
  const [selected, setSelected] = useState("t0");
  const onSelect = useCallback((id: string) => setSelected(id), []);
  return (
    <ul>
      {TRACES.map((t) => (
        <li key={t.id}>
          <RunListButton
            trace={t}
            active={t.id === selected}
            onSelect={stable ? onSelect : (id: string) => setSelected(id)}
          />
        </li>
      ))}
    </ul>
  );
}

beforeEach(() => {
  vi.mocked(formatDuration).mockClear();
});

describe("RunListButton memoisation", () => {
  it("re-renders only the two rows whose `active` flipped", () => {
    render(<Harness stable />);
    expect(renderCount()).toBe(ROWS); // initial mount, one call per row

    vi.mocked(formatDuration).mockClear();
    fireEvent.click(screen.getByRole("button", { name: /Run 7\b/ }));

    // Old active row + new active row. Everything else is memo-skipped.
    expect(renderCount()).toBe(2);
  });

  it("is defeated by a per-row closure — the form this replaced", () => {
    render(<Harness stable={false} />);
    vi.mocked(formatDuration).mockClear();
    fireEvent.click(screen.getByRole("button", { name: /Run 7\b/ }));

    expect(renderCount()).toBe(ROWS);
  });
});

describe("RunTranscript virtualisation", () => {
  it("mounts a bounded window of rows for a 5,000-span trace", () => {
    const steps: TranscriptStep[] = Array.from({ length: 5000 }, (_, i) => ({
      id: `s${i}`,
      spanId: `s${i}`,
      kind: "tool",
      title: `Span ${i}`,
      durationMs: 12,
    })) as TranscriptStep[];

    const { container } = render(<RunTranscript steps={steps} />);
    const mounted = container.querySelectorAll("[data-step-id]").length;

    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(60);

    // Scroll geometry still describes the whole list, and rows carry
    // the set/position semantics a screen reader needs now that only a
    // window of them exists in the DOM.
    const list = container.querySelector("ol");
    expect(list?.getAttribute("style")).toMatch(/height: \d{4,}px/);
    expect(
      container.querySelector("[data-step-id]")?.getAttribute("aria-setsize"),
    ).toBe("5000");
  });

  it("keeps a 200-step trace virtualised with full scroll geometry", () => {
    // Timestamped but strictly sequential — the parallel grouper must
    // pass every step through as its own row.
    const t0 = Date.parse("2026-08-04T10:00:00.000Z");
    const steps: TranscriptStep[] = Array.from({ length: 200 }, (_, i) => ({
      id: `s${i}`,
      spanId: `s${i}`,
      kind: "tool",
      title: `Span ${i}`,
      durationMs: 12,
      startedAt: new Date(t0 + i * 20).toISOString(),
    })) as TranscriptStep[];

    const { container } = render(<RunTranscript steps={steps} />);
    const mounted = container.querySelectorAll("[data-step-id]").length;

    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(60);
    // 200 collapsed rows × ~44px ≥ four digits of scroll height.
    const list = container.querySelector("ol");
    expect(list?.getAttribute("style")).toMatch(/height: \d{4,}px/);
    expect(
      container.querySelector("[data-step-id]")?.getAttribute("aria-setsize"),
    ).toBe("200");
  });
});
