// @vitest-environment jsdom
/**
 * Wave 10 — dashboard clarity:
 *  - Recent runs + Fleet render by default (the queries are unconditional;
 *    hiding them behind a button only gated the render).
 *  - KPI hints use plain language ("last 24h", "recent runs") instead of
 *    internal jargon ("24h · analytics").
 *  - "Needs attention" shows a "See all N runs" link when the list is
 *    truncated to 3.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TraceFixture } from "@/lab/fixtures/traces";
import type { AgentFixture } from "@/lab/fixtures/agents";
import type { IssueFixture } from "@/lab/fixtures/issues";

let mockTraces: TraceFixture[] = [];
let mockIssues: IssueFixture[] = [];
let mockAgents: AgentFixture[] = [];

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/home",
}));

vi.mock("@/hooks/use-org", () => ({
  useOrg: () => ({ currentOrg: { id: "org_1" } }),
}));

vi.mock("@/hooks/use-api-query", () => ({
  useOrgQuery: (key: readonly unknown[]) => {
    const resource = key[1];
    if (resource === "traces") {
      return { data: mockTraces, isLoading: false, isError: false, error: null, refetch: vi.fn(), isFetching: false };
    }
    if (resource === "issues") {
      return { data: mockIssues, isLoading: false, isError: false, error: null, refetch: vi.fn(), isFetching: false };
    }
    if (resource === "agents") {
      return { data: mockAgents, isLoading: false, isError: false, error: null, refetch: vi.fn(), isFetching: false };
    }
    if (resource === "keys") {
      return { data: [{ id: "k1", status: "active" }], isLoading: false, isError: false, error: null, refetch: vi.fn(), isFetching: false };
    }
    if (resource === "costKpi") {
      return { data: undefined, isError: false, error: null, refetch: vi.fn(), isFetching: false };
    }
    // autonomyPolicy (AutonomyRoiBanner) → no banner
    return { data: undefined, isError: false, error: null, refetch: vi.fn(), isFetching: false };
  },
}));

vi.mock("@/lib/api/portal", () => ({
  portalApi: {
    traces: vi.fn(),
    issues: vi.fn(),
    agents: vi.fn(),
  },
}));

vi.mock("@/lib/api/resources", () => ({
  wave6Api: { costKpi: vi.fn() },
  api: { getAutonomyPolicy: vi.fn() },
}));

vi.mock("@/lab/alerts-context", () => ({
  useAlerts: () => ({
    openAlerts: vi.fn(),
  }),
}));

vi.mock("@/lib/portal-polish", () => ({
  FIRST_EVENT_WAIT: { title: "Waiting", description: "desc", pollMs: 5000 },
  U20_EMPTY_COPY: { attentionClear: "No failing runs", dashboardTraces: "No runs", agents: "No agents" },
}));

vi.mock("@/components/shell/first-event-wait", () => ({
  FirstEventWaitAction: () => null,
}));

vi.mock("@/lab/autonomy-roi-banner", () => ({
  AutonomyRoiBanner: () => null,
}));

function makeTrace(id: string, severity: "error" | "warn" | "none"): TraceFixture {
  return {
    id,
    agentId: "agent_1",
    name: `Run ${id}`,
    status: severity === "error" ? "error" : "ok",
    startedAt: "2026-08-01T00:00:00Z",
    durationMs: 100,
    tokens: 10,
    costUsd: 0.01,
    severity,
    signals: { title: severity === "none" ? "" : `Signal ${id}`, body: "body" },
    steps: [],
  };
}

const ERROR_A = makeTrace("t_err_a", "error");
const ERROR_B = makeTrace("t_err_b", "error");
const ERROR_C = makeTrace("t_err_c", "error");
const ERROR_D = makeTrace("t_err_d", "error");

const AGENTS = [
  {
    id: "agent_1",
    name: "Sam",
    purpose: "planner",
    status: "live",
    env: "prod",
    model: "gpt-4o",
    runs24h: 4,
    successRate: 0.95,
    errorRate: 0.05,
    p50Ms: 100,
    p95Ms: 400,
    costUsd24h: 0.4,
    tokens24h: 1000,
    openIssues: 1,
    lastSeen: "2026-08-01T00:00:00Z",
  },
] as unknown as AgentFixture[];

const { default: HomeClient } = await import("./home-client");

describe("HomeClient (Wave 10 dashboard clarity)", () => {
  it("renders Recent runs and Fleet by default — no click needed", () => {
    mockTraces = [makeTrace("t_ok", "none")];
    mockIssues = [];
    mockAgents = AGENTS;
    render(<HomeClient />);

    expect(screen.getByRole("heading", { name: "Runs & fleet" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Recent runs" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Fleet" })).toBeTruthy();
    expect(screen.getByText("Sam")).toBeTruthy();
  });

  it("uses plain-language KPI hints instead of internal jargon", () => {
    mockTraces = [makeTrace("t_ok", "none")];
    mockIssues = [];
    mockAgents = [];
    render(<HomeClient />);

    // Traces / Failures KPI: known data uses "last 24h" (R063).
    expect(screen.getAllByText("last 24h").length).toBeGreaterThan(0);
    expect(screen.queryByText("none")).toBeNull();
    expect(screen.queryByText("Create API key")).toBeNull();
  });

  it("shows a See-all link when Needs attention exceeds 3", () => {
    mockTraces = [ERROR_A, ERROR_B, ERROR_C, ERROR_D];
    mockIssues = [];
    mockAgents = [];
    render(<HomeClient />);

    expect(
      screen.getByText("See all 4 runs needing attention"),
    ).toBeTruthy();
    // The header notes the truncation explicitly.
    expect(screen.getByText(/showing 3 of 4/)).toBeTruthy();
  });
  it("renders all four KPIs including Spend (R100)", () => {
    mockTraces = [];
    mockIssues = [];
    mockAgents = [];
    render(<HomeClient />);
    expect(screen.getByRole("link", { name: /Failures:/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Traces:/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Agents:/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Spend:/ })).toBeTruthy();
  });

  it("does not nag Create API key when a key exists and traces are empty (R050)", () => {
    mockTraces = [];
    mockIssues = [];
    mockAgents = [];
    render(<HomeClient />);
    expect(screen.queryByText("Create API key")).toBeNull();
    expect(screen.getByText("API keys")).toBeTruthy();
  
  });
});
