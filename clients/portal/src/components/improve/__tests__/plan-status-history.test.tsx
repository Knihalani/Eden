import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ImprovementPlan } from "@/lib/api/resources";
import type { ImprovePlanFixture } from "@/lab/fixtures/improve";
import {
  PlanStatusHistory,
  derivePlanHistory,
} from "../plan-status-history";

const plan: ImprovePlanFixture = {
  id: "plan_1",
  title: "Fix tool timeout",
  summary: "Bump tool timeout",
  status: "verify",
  kind: "code_patch",
  agentId: "agent_1",
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-02T00:00:00Z",
  caseIds: [],
  issueIds: [],
  traceIds: [],
  rca: "",
  before: "",
  after: "",
  primaryAction: "open_trace",
};

const raw: ImprovementPlan = {
  id: "plan_1",
  org_id: "org_1",
  plan_kind: "code_patch",
  status: "pr_opened",
  title: "Fix tool timeout",
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-03T00:00:00Z",
  approved_at: "2026-08-02T12:00:00Z",
  approved_by: "user_9",
  pr_url: "https://github.com/acme/repo/pull/42",
  pr_number: 42,
};

describe("derivePlanHistory", () => {
  it("derives created / approved / PR / updated / current-status events", () => {
    const keys = derivePlanHistory(plan, raw).map((e) => e.key);
    expect(keys).toEqual(["created", "approved", "pr", "updated", "status"]);
  });

  it("falls back to fixture timestamps for local drafts (raw=null)", () => {
    const events = derivePlanHistory(plan, null);
    expect(events.map((e) => e.key)).toEqual(["created", "updated", "status"]);
    expect(events.at(-1)?.label).toBe("Current status: verify");
  });
});

describe("PlanStatusHistory", () => {
  it("renders the derived timeline and states the missing-endpoint gap", () => {
    render(<PlanStatusHistory plan={plan} raw={raw} />);

    expect(screen.getByText("Plan created")).toBeInTheDocument();
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(screen.getByText("by user_9")).toBeInTheDocument();
    expect(screen.getByText("PR #42 opened")).toBeInTheDocument();
    expect(
      screen.getByText("Current status: pr_opened"),
    ).toBeInTheDocument();
    // Honest labeling: derived, not a real event log.
    expect(
      screen.getByText(/does not expose a per-plan event log/),
    ).toBeInTheDocument();
  });
});
