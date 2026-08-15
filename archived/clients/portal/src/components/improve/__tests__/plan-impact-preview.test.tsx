import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImprovePlanFixture } from "@/lab/fixtures/improve";

const previewFn = vi.fn();
vi.mock("@/lib/api/resources", () => ({
  changeImpactApi: {
    preview: (...args: unknown[]) => previewFn(...args),
  },
}));

const { PlanImpactPreview } = await import("../plan-impact-preview");

const plan: ImprovePlanFixture = {
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
  traceIds: ["tr_1"],
  rca: "",
  before: "",
  after: "",
  primaryAction: "open_trace",
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("PlanImpactPreview", () => {
  it("disables the button for local draft plans with an explanation", () => {
    render(
      <PlanImpactPreview orgId="org_1" plan={plan} raw={null} isDraft />,
    );

    const btn = screen.getByRole("button", { name: "Preview impact" });
    expect(btn).toBeDisabled();
    expect(
      screen.getByText("Unavailable for local draft plans."),
    ).toBeInTheDocument();
    expect(previewFn).not.toHaveBeenCalled();
  });

  it("runs the change-impact preview live and renders the report", async () => {
    previewFn.mockResolvedValue({
      data: {
        report: {
          traces_replayed: 12,
          trajectory_divergence_rate: 0.25,
          new_predicted_stumbles: 2,
          recommendation: "block",
          recommendation_reasons: ["divergence above threshold"],
        },
      },
    });

    render(
      <PlanImpactPreview
        orgId="org_1"
        plan={plan}
        raw={{
          id: "plan_1",
          org_id: "org_1",
          plan_kind: "code_patch",
          status: "pending_review",
          title: "Fix tool timeout",
          created_at: "2026-08-01T00:00:00Z",
          updated_at: "2026-08-02T00:00:00Z",
          agent_id: "agent_1",
          files_changed: [{ path: "prompts/agent.md" }],
          evidence: { example_trace_ids: ["tr_2"] },
        }}
        isDraft={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Preview impact" }));

    expect(await screen.findByTestId("impact-report")).toBeInTheDocument();
    expect(previewFn).toHaveBeenCalledWith("org_1", {
      change_id: "plan_1",
      changed_files: ["prompts/agent.md"],
      agent_id: "agent_1",
      trace_ids: ["tr_2", "tr_1"],
    });
    expect(screen.getByText("block")).toBeInTheDocument();
    expect(
      screen.getByText("divergence above threshold"),
    ).toBeInTheDocument();
  });

  it("degrades to a placeholder message when the feature flag is off", async () => {
    previewFn.mockRejectedValue(new Error("403 feature flag disabled"));

    render(
      <PlanImpactPreview orgId="org_1" plan={plan} raw={null} isDraft={false} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Preview impact" }));

    expect(
      await screen.findByText(/change_impact_preview_v1/),
    ).toBeInTheDocument();
  });
});
