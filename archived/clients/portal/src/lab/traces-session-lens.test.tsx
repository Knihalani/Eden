// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// N12 — the session lens' turns section fetches the real ordered
// timeline (`GET /orgs/{org}/sessions/{id}/timeline`) and renders
// TurnCard rows (cost / duration / stumble badges / issue chips /
// summary) with a trace cross-link and the link-issue action.

const timelineMock = vi.fn();
const linkIssueMock = vi.fn();

vi.mock("@/lib/api/resources", () => ({
  sessionsApi: {
    timeline: (...a: unknown[]) => timelineMock(...a),
    linkIssue: (...a: unknown[]) => linkIssueMock(...a),
  },
}));

vi.mock("@/hooks/use-org", () => ({
  useOrg: () => ({ currentOrg: { id: "org_1" } }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: unknown;
    children: React.ReactNode;
  }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

import { SessionTurnsSection } from "./traces-session-lens";
import type { SessionFixture } from "@/lab/fixtures/sessions";

function withClient(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

const SESSION: SessionFixture = {
  id: "sess_1",
  agentId: "agent_1",
  startedAt: "2026-08-01T00:00:00Z",
  turnCount: 1,
  outcome: "error",
  durationMs: 1200,
  totalTokens: 100,
  costUsd: 0.02,
  relatedIssueIds: [],
  traceIds: ["trace_abc"],
};

const TURN = {
  index: 1,
  trace_id: "trace_abc",
  started_at: "2026-08-01T00:00:00Z",
  ended_at: "2026-08-01T00:00:01Z",
  duration_ms: 1200,
  cost_usd: 0.02,
  input_tokens: 60,
  output_tokens: 40,
  outcome: "error",
  error_type: "ToolError",
  had_stumble: true,
  stumble_kinds: ["retry_loop"],
  issues: [
    { issue_id: "iss_9", status: "open", severity: "error", title: "Tool crash" },
  ],
  summary: "Agent retried the failing tool three times.",
};

beforeEach(() => {
  timelineMock.mockReset();
  linkIssueMock.mockReset();
});

describe("SessionTurnsSection (N12)", () => {
  it("renders real turns with stumble kinds, issue chips and summary", async () => {
    timelineMock.mockResolvedValue({ turns: [TURN] });
    render(
      withClient(
        <SessionTurnsSection
          session={SESSION}
          fallbackTurns={[]}
          onOpenTurn={vi.fn()}
        />,
      ),
    );

    expect(await screen.findByText("retry_loop")).toBeTruthy();
    expect(screen.getByText("Tool crash")).toBeTruthy();
    expect(
      screen.getByText("Agent retried the failing tool three times."),
    ).toBeTruthy();
  });

  it("cross-links a turn to its trace via onOpenTurn", async () => {
    const onOpenTurn = vi.fn();
    timelineMock.mockResolvedValue({ turns: [TURN] });
    render(
      withClient(
        <SessionTurnsSection
          session={SESSION}
          fallbackTurns={[]}
          onOpenTurn={onOpenTurn}
        />,
      ),
    );

    fireEvent.click(await screen.findByRole("button", { name: "trace_abc" }));
    expect(onOpenTurn).toHaveBeenCalledWith("trace_abc");
  });

  it("links an issue to the session", async () => {
    timelineMock.mockResolvedValue({ turns: [TURN] });
    linkIssueMock.mockResolvedValue({
      status: "ok",
      session_id: "sess_1",
      linked_issue_id: "iss_42",
    });
    render(
      withClient(
        <SessionTurnsSection
          session={SESSION}
          fallbackTurns={[]}
          onOpenTurn={vi.fn()}
        />,
      ),
    );

    await screen.findByText("retry_loop");
    fireEvent.change(screen.getByLabelText("Issue id to link"), {
      target: { value: "iss_42" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Link" }));

    await waitFor(() =>
      expect(linkIssueMock).toHaveBeenCalledWith("org_1", "sess_1", "iss_42"),
    );
  });
});
