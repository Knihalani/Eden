// @vitest-environment jsdom
/**
 * Wave 10 — ⌘K palette is a live jump-to-anything: traces, issues, agents,
 * and a direct trace-id jump, merged with the static nav commands.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const traces = vi.fn();
const issues = vi.fn();
const agents = vi.fn();
const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@/hooks/use-org", () => ({
  useOrg: () => ({ currentOrg: { id: "org-1" } }),
}));

vi.mock("@/lib/api/portal", () => ({
  portalApi: {
    traces: (...args: unknown[]) => traces(...args),
    issues: (...args: unknown[]) => issues(...args),
    agents: (...args: unknown[]) => agents(...args),
  },
}));

import { CommandPalette } from "./command-palette";
import { OPEN_PALETTE_EVENT } from "@/lib/palette";
import type { TraceFixture } from "@/lab/fixtures/traces";
import type { IssueFixture } from "@/lab/fixtures/issues";
import type { AgentFixture } from "@/lab/fixtures/agents";

const TRACES = [
  {
    id: "tr_planning_run_001",
    agentId: "agent-sam",
    name: "planning",
    startedAt: "2026-08-01T00:00:00Z",
    severity: "error",
  },
  {
    id: "tr_summarizer_002",
    agentId: "agent-lex",
    name: "summarize",
    startedAt: "2026-08-01T00:01:00Z",
    severity: "none",
  },
] as unknown as TraceFixture[];

function openPalette() {
  render(<CommandPalette />);
  fireEvent.keyDown(window, { key: "k", metaKey: true });
}

describe("CommandPalette (Wave 10 live search)", () => {
  beforeEach(() => {
    traces.mockReset();
    issues.mockReset();
    agents.mockReset();
    push.mockReset();
    traces.mockResolvedValue(TRACES);
    issues.mockResolvedValue([]);
    agents.mockResolvedValue([]);
  });

  it("opens on Cmd+K and surfaces live runs under a Runs group", async () => {
    openPalette();
    expect(await screen.findByText("planning")).toBeTruthy();
    expect(screen.getByText("Runs")).toBeTruthy();
  });

  it("opens via the visible trigger event (sidebar / mobile header)", async () => {
    render(<CommandPalette />);
    window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT));
    expect(await screen.findByText("planning")).toBeTruthy();
  });

  it("filters runs as you type and Enter jumps to the trace", async () => {
    openPalette();
    await screen.findByText("planning");
    const input = screen.getByPlaceholderText(/Go to a run/);
    fireEvent.change(input, { target: { value: "summarize" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(
        "/traces?id=tr_summarizer_002&agent=agent-lex",
      );
    });
  });

  it("offers a direct 'Open run' jump for a pasted trace id", async () => {
    openPalette();
    await screen.findByText("planning");
    const input = screen.getByPlaceholderText(/Go to a run/);
    fireEvent.change(input, {
      target: { value: "tr_fresh_pasted_id_123" },
    });
    expect(
      await screen.findByText(/Open run tr_fresh_pasted_id_123/),
    ).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith("/traces?id=tr_fresh_pasted_id_123");
    });
  });

  it("surfaces issues and agents in their own groups", async () => {
    issues.mockResolvedValue([
      {
        id: "iss_1",
        title: "Token overflow",
        severity: "error",
        status: "open",
        agentId: "agent-sam",
        occurrenceTraceIds: ["tr_planning_run_001"],
      },
    ] as unknown as IssueFixture[]);
    agents.mockResolvedValue([
      { id: "agent-sam", name: "Sam", purpose: "planner" },
    ] as unknown as AgentFixture[]);
    openPalette();
    expect(await screen.findByText("Token overflow")).toBeTruthy();
    expect(screen.getByText("Sam")).toBeTruthy();
    // Live groups render (the static sidebar also has "Issues" nav items,
    // so assert the group headers exist rather than a single match).
    expect(screen.getAllByText("Issues").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Agents").length).toBeGreaterThanOrEqual(1);
  });

  it("does not navigate on Enter when nothing matches", async () => {
    openPalette();
    await screen.findByText("planning");
    const input = screen.getByPlaceholderText(/Go to a run/);
    // Spaces make it non-id-like, so no direct-jump and no live match.
    fireEvent.change(input, { target: { value: "no such thing here" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(push).not.toHaveBeenCalled();
  });

  it("defaults the highlight to Home when the query is empty", async () => {
    openPalette();
    const input = screen.getByPlaceholderText(/Go to a run/);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith("/home");
    });
  });

  it("navigates the result list with ArrowDown/ArrowUp and Enter runs the highlighted item", async () => {
    openPalette();
    const input = screen.getByPlaceholderText(/Go to a run/);
    fireEvent.change(input, { target: { value: "tr_" } });
    await screen.findByText("planning");

    // Live matches rank first while typing; ArrowDown → summarize.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(
        "/traces?id=tr_summarizer_002&agent=agent-lex",
      );
    });
  });

  it("wraps ArrowUp from the first result to the last", async () => {
    openPalette();
    await screen.findByText("planning");
    const input = screen.getByPlaceholderText(/Go to a run/);

    // Static commands are appended after the live runs, so the last item
    // is a static one — ArrowUp from index 0 must wrap to it without error.
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(push).toHaveBeenCalled();
  });
});

describe("CommandPalette (Wave 13 interaction layer)", () => {
  beforeEach(() => {
    traces.mockReset();
    issues.mockReset();
    agents.mockReset();
    push.mockReset();
    traces.mockResolvedValue(TRACES);
    issues.mockResolvedValue([]);
    agents.mockResolvedValue([]);
  });

  it("does not show a skeleton row on top of static commands while idle", () => {
    traces.mockReturnValue(new Promise(() => undefined));
    issues.mockReturnValue(new Promise(() => undefined));
    agents.mockReturnValue(new Promise(() => undefined));
    openPalette();
    expect(screen.queryByText("Loading runs…")).toBeNull();
    expect(screen.getByText("Observe")).toBeTruthy();
  });

  it("clears the loading hint and keeps static commands when the live fetch fails", async () => {
    traces.mockRejectedValue(new Error("offline"));
    issues.mockRejectedValue(new Error("offline"));
    agents.mockRejectedValue(new Error("offline"));
    openPalette();
    // The hint disappears after the failure settles; static nav remains.
    await waitFor(() => {
      expect(screen.queryByText("Loading runs…")).toBeNull();
    });
    expect(screen.getByText("Observe")).toBeTruthy();
  });

  it("renders keyboard hints in the footer", async () => {
    openPalette();
    await screen.findByText("planning");
    expect(screen.getByText("↑↓ navigate")).toBeTruthy();
    expect(screen.getByText("↵ open")).toBeTruthy();
    expect(screen.getByText("esc close")).toBeTruthy();
  });

  it("describes run severity in the shared vocabulary (Failed, not error)", async () => {
    openPalette();
    // The error-severity run must read "Failed" in its description, not
    // the raw enum fragment "error" (Wave 11 one-vocabulary mandate).
    expect(
      await screen.findByText(/· Failed$/),
    ).toBeTruthy();
  });

  it("offers a clear button that empties the query and keeps focus", async () => {
    openPalette();
    await screen.findByText("planning");
    const input = screen.getByPlaceholderText(/Go to a run/);
    fireEvent.change(input, { target: { value: "summarize" } });
    const clear = screen.getByRole("button", { name: "Clear search" });
    fireEvent.click(clear);
    expect((input as HTMLInputElement).value).toBe("");
    expect(input).toHaveFocus();
  });

  it("explains an empty result instead of a bare 'No matches'", async () => {
    openPalette();
    await screen.findByText("planning");
    const input = screen.getByPlaceholderText(/Go to a run/);
    fireEvent.change(input, {
      target: { value: "no such thing here" },
    });
    expect(await screen.findByText(/No matches for “no such thing here”/)).toBeTruthy();
    expect(
      screen.getByText("Try a run id, issue title, agent name, or page."),
    ).toBeTruthy();
  });
});
