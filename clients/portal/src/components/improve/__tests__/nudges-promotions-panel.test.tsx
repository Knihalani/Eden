import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const promoteFn = vi.fn();
const archiveFn = vi.fn();
vi.mock("@/lib/api/resources", () => ({
  nudgesApi: {
    list: vi.fn(),
    promote: (...args: unknown[]) => promoteFn(...args),
    archive: (...args: unknown[]) => archiveFn(...args),
  },
  promotionsApi: {
    list: vi.fn(),
  },
}));

const pushToast = vi.fn();
vi.mock("@/lab/lab-toast", () => ({
  useLabToast: () => ({ pushToast }),
}));

type QueryState = {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: ReturnType<typeof vi.fn>;
};

let nudgesState: QueryState;
let promotionsState: QueryState;
const refetch = vi.fn();

vi.mock("@/hooks/use-api-query", () => ({
  useOrgQuery: (key: readonly unknown[]) =>
    key[0] === "nudges" ? nudgesState : promotionsState,
}));

const { NudgesPromotionsPanel } = await import("../nudges-promotions-panel");

function setNudges(nudges: Array<Record<string, unknown>>) {
  nudgesState = {
    data: { data: { nudges } },
    isLoading: false,
    isError: false,
    error: null,
    refetch,
  };
}

function setPromotions(promotions: Array<Record<string, unknown>>) {
  promotionsState = {
    data: { data: { promotions } },
    isLoading: false,
    isError: false,
    error: null,
    refetch,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("NudgesPromotionsPanel", () => {
  it("shows an honest empty state when the org has no nudges", () => {
    setNudges([]);
    setPromotions([]);
    render(<NudgesPromotionsPanel orgId="org_1" agentId="all" />);

    expect(screen.getByText("No nudges yet")).toBeInTheDocument();
  });

  it("renders nudge mode and the matching promotion candidate status", () => {
    setNudges([
      {
        id: "nudge_1",
        agent_id: "agent_1",
        name: "Retry on tool timeout",
        mode: "shadow",
        action_type: "system_append",
      },
    ]);
    setPromotions([
      {
        id: "cand_1",
        kind: "nudge",
        ref_id: "nudge_1",
        status: "pending_review",
      },
    ]);

    render(<NudgesPromotionsPanel orgId="org_1" agentId="all" />);

    expect(screen.getByText("Retry on tool timeout")).toBeInTheDocument();
    expect(screen.getByText("shadow")).toBeInTheDocument();
    expect(
      screen.getByText("promotion: pending_review"),
    ).toBeInTheDocument();
  });

  it("promotes a shadow nudge and surfaces the evidence-gate outcome", async () => {
    setNudges([
      {
        id: "nudge_1",
        agent_id: "agent_1",
        name: "Retry on tool timeout",
        mode: "shadow",
        action_type: "system_append",
      },
    ]);
    setPromotions([]);
    promoteFn.mockResolvedValue({
      data: {
        promoted: true,
        report: {
          candidate_id: "cand_1",
          passed: true,
          recommendation: "promote",
          gate_verdict: "PASS",
          explanation: "n=40, effect within bounds",
        },
      },
    });

    render(<NudgesPromotionsPanel orgId="org_1" agentId="all" />);

    fireEvent.click(screen.getByRole("button", { name: "Promote" }));

    await waitFor(() =>
      expect(promoteFn).toHaveBeenCalledWith("org_1", "nudge_1"),
    );
    expect(
      await screen.findByText(/Last evaluation: passed/),
    ).toBeInTheDocument();
    expect(pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "ok", title: "Nudge promoted" }),
    );
  });

  it("archives a shadow nudge", async () => {
    setNudges([
      {
        id: "nudge_1",
        agent_id: "agent_1",
        name: "Retry on tool timeout",
        mode: "shadow",
        action_type: "system_append",
      },
    ]);
    setPromotions([]);
    archiveFn.mockResolvedValue({ data: { archived: true } });

    render(<NudgesPromotionsPanel orgId="org_1" agentId="all" />);

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    await waitFor(() =>
      expect(archiveFn).toHaveBeenCalledWith("org_1", "nudge_1"),
    );
    await waitFor(() =>
      expect(pushToast).toHaveBeenCalledWith(
        expect.objectContaining({ tone: "ok", title: "Nudge archived" }),
      ),
    );
  });

  it("hides promote/archive actions once a nudge has left shadow", () => {
    setNudges([
      {
        id: "nudge_1",
        agent_id: "agent_1",
        name: "Retry on tool timeout",
        mode: "promoted",
        action_type: "system_append",
      },
    ]);
    setPromotions([]);

    render(<NudgesPromotionsPanel orgId="org_1" agentId="all" />);

    expect(
      screen.queryByRole("button", { name: "Promote" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Archive" }),
    ).not.toBeInTheDocument();
  });
});
