import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ImprovementPlan } from "@/lib/api/resources";
import type { ImprovePlanFixture } from "@/lab/fixtures/improve";
import {
  PlanEvidencePanel,
  planTraceIds,
} from "../plan-evidence-panel";

function makePlan(over: Partial<ImprovePlanFixture> = {}): ImprovePlanFixture {
  return {
    id: "plan_1",
    title: "Fix tool timeout",
    summary: "Bump tool timeout",
    status: "needs_you",
    kind: "code_patch",
    agentId: "agent_1",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-02T00:00:00Z",
    caseIds: [],
    issueIds: [],
    traceIds: ["tr_fixture"],
    rca: "timeout too low",
    before: "",
    after: "",
    primaryAction: "open_trace",
    ...over,
  };
}

function makeRaw(evidence: Record<string, unknown>): ImprovementPlan {
  return {
    id: "plan_1",
    org_id: "org_1",
    plan_kind: "code_patch",
    status: "pending_review",
    title: "Fix tool timeout",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-02T00:00:00Z",
    evidence,
  };
}

describe("PlanEvidencePanel", () => {
  it("renders tier, static checks, sandbox tests and CI chips from raw evidence", () => {
    render(
      <PlanEvidencePanel
        plan={makePlan()}
        raw={makeRaw({
          evidence_tier: "static",
          hermetic_preverify: "static_passed",
          sandbox_tests: { status: "passed", synthesized: true },
          auto_merge: { ci_status: "failed" },
          severity: "high",
          confidence: 0.8,
        })}
      />,
    );

    expect(screen.getByText("tier: static")).toBeInTheDocument();
    expect(
      screen.getByText("static checks: static_passed"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("sandbox tests: passed (synthesized)"),
    ).toBeInTheDocument();
    expect(screen.getByText("CI: failed")).toBeInTheDocument();
    expect(screen.getByText("severity: high")).toBeInTheDocument();
    expect(screen.getByText("confidence: 80%")).toBeInTheDocument();
  });

  it("links cited traces to /traces?id= via citation-href", () => {
    render(
      <PlanEvidencePanel
        plan={makePlan()}
        raw={makeRaw({ example_trace_ids: ["tr_evidence"] })}
      />,
    );

    const links = screen.getAllByRole("link");
    const hrefs = links.map((l) => l.getAttribute("href"));
    expect(hrefs).toContain("/traces?id=tr_evidence");
    expect(hrefs).toContain("/traces?id=tr_fixture");
  });

  it("dedupes evidence trace ids against fixture trace ids", () => {
    const plan = makePlan({ traceIds: ["tr_a"] });
    const raw = makeRaw({ example_trace_ids: ["tr_a", "tr_b"] });
    expect(planTraceIds(plan, raw)).toEqual(["tr_a", "tr_b"]);
  });

  it("shows an honest empty state when no evidence is attached", () => {
    render(
      <PlanEvidencePanel
        plan={makePlan({ traceIds: [] })}
        raw={makeRaw({})}
      />,
    );

    expect(
      screen.getByText(/No evidence attached/),
    ).toBeInTheDocument();
  });

  it("surfaces merged supervision status from raw plan + evidence", () => {
    render(
      <PlanEvidencePanel
        plan={makePlan({ status: "done", prUrl: "https://github.com/o/r/pull/1" })}
        raw={{
          ...makeRaw({
            auto_merge: { merged: true, manual: true, eligible: false },
          }),
          status: "merged",
        }}
      />,
    );

    expect(screen.getByText("supervision: merged (manual)")).toBeInTheDocument();
  });
});
