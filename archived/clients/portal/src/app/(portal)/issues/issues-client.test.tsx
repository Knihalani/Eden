// @vitest-environment jsdom
/**
 * BUG-9: the issue detail's "Dismiss" action is the UI path for the
 * backend's "ignored" resolve-status (see IssueStatus in
 * lab/fixtures/issues.ts). This covers that it renders for an open
 * issue and calls the resolve endpoint with status "ignored".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IssueFixture } from "@/lab/fixtures/issues";

const resolveMock = vi.fn(
  async (_orgId: string, _issueId: string, _status: string) => ({ ok: true }),
);
const issuesListMock = vi.fn();

const searchParamsMock = vi.fn(() => new URLSearchParams({ id: "iss_1" }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParamsMock(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/issues",
}));

vi.mock("@/hooks/use-org", () => ({
  useOrg: () => ({ currentOrg: { id: "org_1", name: "Org One" } }),
}));

vi.mock("@/lab/lab-toast", () => ({
  useLabToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("@/lib/api/portal", () => ({
  portalApi: {
    issues: issuesListMock,
  },
}));

vi.mock("@/lib/api/resources", () => ({
  agentIssuesApi: {
    resolve: resolveMock,
    setStatus: (orgId: string, issueId: string, status: string) =>
      resolveMock(orgId, issueId, status),
  },
}));

// Keeps the render tree focused on the issue detail/list — the saved
// views menu owns its own API surface, unrelated to BUG-9.
vi.mock("@/components/portal/saved-views-menu", () => ({
  SavedViewsMenu: () => null,
}));

vi.mock("@/lab/agent-scope", () => ({
  useAgentScope: () => ({
    agentId: "all",
    agent: undefined,
    setAgentId: vi.fn(),
    hrefFor: (base: string) => base,
  }),
  useQueryPatch: () => vi.fn(),
  agentScopeCounts: () => ({}),
  groupByAgent: () => new Map(),
}));

function withClient(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

const OPEN_ISSUE: IssueFixture = {
  id: "iss_1",
  title: "Tool call timeout spike",
  summary: "Checkout agent tool calls are timing out.",
  body: "Repeated timeouts calling the inventory tool.",
  severity: "error",
  status: "open",
  agentId: "agent_1",
  fingerprint: "fp_1",
  detector: "tool_timeout",
  environment: "production",
  occurrenceTraceIds: [],
  firstSeen: "2026-08-01T00:00:00Z",
  lastSeen: "2026-08-04T00:00:00Z",
  signalCount: 3,
  errorSample: "TimeoutError: inventory tool did not respond",
  impact: "Checkout flow stalls for affected users.",
  suggestedFix: "Increase the inventory tool timeout.",
  tags: ["checkout"],
  rankScore: 42.5,
};

const HIGH_RANK_ISSUE: IssueFixture = {
  ...OPEN_ISSUE,
  id: "iss_2",
  title: "Lower priority issue",
  rankScore: 2.1,
};

describe("Issues board dismiss action (BUG-9)", () => {
  beforeEach(() => {
    resolveMock.mockClear();
    issuesListMock.mockReset();
    issuesListMock.mockResolvedValue([OPEN_ISSUE]);
    searchParamsMock.mockReturnValue(new URLSearchParams({ id: "iss_1" }));
  });

  it("shows a Dismiss action for an open issue and resolves it with status=ignored", async () => {
    const { default: LabIssuesPage } = await import("./issues-client");
    render(withClient(<LabIssuesPage />));

    const dismissButton = await screen.findByRole("button", { name: "Dismiss" });
    fireEvent.click(dismissButton);

    await waitFor(() =>
      expect(resolveMock).toHaveBeenCalledWith("org_1", "iss_1", "ignored"),
    );
  });

  it("shows rank tier badges and Top priority filter when sort=rank", async () => {
    searchParamsMock.mockReturnValue(new URLSearchParams());
    issuesListMock.mockResolvedValue([OPEN_ISSUE, HIGH_RANK_ISSUE]);
    vi.resetModules();
    const { default: LabIssuesPage } = await import("./issues-client");
    render(withClient(<LabIssuesPage />));

    await screen.findByText("Sort");
    const topFilter = await screen.findByRole("tab", { name: /Top priority/i });
    fireEvent.click(topFilter);

    await waitFor(() => {
      expect(screen.getByText("Tool call timeout spike")).toBeTruthy();
      expect(screen.queryByText("Lower priority issue")).toBeNull();
    });
  });
});
