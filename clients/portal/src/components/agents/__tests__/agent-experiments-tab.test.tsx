import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const listFn = vi.fn();
const runFn = vi.fn();
const compareFn = vi.fn();
vi.mock("@/lib/api/resources", () => ({
  offlineExperimentsApi: {
    list: (...args: unknown[]) => listFn(...args),
    run: (...args: unknown[]) => runFn(...args),
    compare: (...args: unknown[]) => compareFn(...args),
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

let queryState: QueryState;
const refetch = vi.fn();
vi.mock("@/hooks/use-api-query", () => ({
  useOrgQuery: () => queryState,
}));

const { AgentExperimentsTab } = await import("../agent-experiments-tab");

function setExperiments(experiments: Array<Record<string, unknown>>) {
  queryState = {
    data: { experiments, total: experiments.length },
    isLoading: false,
    isError: false,
    error: null,
    refetch,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("AgentExperimentsTab", () => {
  it("shows an empty state when the org has no experiments", () => {
    setExperiments([]);
    render(<AgentExperimentsTab orgId="org_1" agentId="agent_1" />);

    expect(screen.getByText("No experiments yet")).toBeInTheDocument();
  });

  it("lists experiments and runs one via POST /{id}/run", async () => {
    setExperiments([
      {
        id: "exp_1",
        name: "Retry policy A/B",
        status: "created",
        created_at: "2026-08-01T00:00:00Z",
      },
    ]);
    runFn.mockResolvedValue({ result: { status: "completed", rows: 40 } });

    render(<AgentExperimentsTab orgId="org_1" agentId="agent_1" />);

    expect(screen.getByText("Retry policy A/B")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(runFn).toHaveBeenCalledWith("org_1", "exp_1"));
    await waitFor(() =>
      expect(pushToast).toHaveBeenCalledWith(
        expect.objectContaining({ tone: "ok" }),
      ),
    );
  });

  it("compares an experiment and renders the summary inline", async () => {
    setExperiments([{ id: "exp_1", name: "Retry policy A/B" }]);
    compareFn.mockResolvedValue({
      compare: {
        summary: { better: 3, worse: 1 },
        baseline_experiment_id: "exp_base",
      },
    });

    render(<AgentExperimentsTab orgId="org_1" agentId="agent_1" />);

    fireEvent.click(screen.getByRole("button", { name: "Compare" }));

    await waitFor(() =>
      expect(compareFn).toHaveBeenCalledWith("org_1", "exp_1"),
    );
    expect(
      await screen.findByText(/better: 3 · worse: 1/),
    ).toBeInTheDocument();
  });

  it("scopes out experiments pinned to a different agent", () => {
    setExperiments([
      { id: "exp_1", name: "Mine", config: { agent_id: "agent_1" } },
      { id: "exp_2", name: "Other agent", config: { agent_id: "agent_2" } },
      { id: "exp_3", name: "Org-wide" },
    ]);

    render(<AgentExperimentsTab orgId="org_1" agentId="agent_1" />);

    expect(screen.getByText("Mine")).toBeInTheDocument();
    expect(screen.getByText("Org-wide")).toBeInTheDocument();
    expect(screen.queryByText("Other agent")).not.toBeInTheDocument();
  });
});
