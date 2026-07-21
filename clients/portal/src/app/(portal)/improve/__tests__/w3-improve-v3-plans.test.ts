/**
 * Wave 3 — Improve V3 plans list + plan detail.
 * Calm KPI, RQ migrate, Diff/Summary, Dialog mutations, toast honesty.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WAVE3_IMPROVE_PLANS_COMPLETED } from "../_components/improve-constants";

const portalSrc = resolve(__dirname, "../../../../");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("Wave 3 improve V3 plans", () => {
  const list = read("app/(portal)/improve/plans/page.tsx");
  const detail = read("app/(portal)/improve/plans/[id]/page.tsx");
  const detailBody = read(
    "app/(portal)/improve/plans/[id]/_components/plan-detail-body.tsx",
  );
  const detailHook = read(
    "app/(portal)/improve/plans/[id]/_components/use-plan-detail.ts",
  );
  const diff = read("components/improve/diff-viewer.tsx");
  const summary = read("components/improve/plan-summary-panel.tsx");
  const badge = read("components/improve/plan-kind-badge.tsx");
  const runs = read("app/(portal)/improve/runs/page.tsx");
  const constants = read("app/(portal)/improve/_components/improve-constants.ts");

  it("3.6 marks wave3-improve-plans completed", () => {
    expect(WAVE3_IMPROVE_PLANS_COMPLETED).toBe(true);
    expect(constants).toContain("WAVE3_IMPROVE_PLANS_COMPLETED = true");
    expect(list).toContain('data-wave3-improve-plans="completed"');
    expect(detail).toContain('data-wave3-improve-plans="completed"');
    expect(existsSync(resolve(portalSrc, "../.wave3-improve-critic.md"))).toBe(true);
  });

  it("3.1 plans list calm hierarchy + RQ (no StatCard wall)", () => {
    expect(list).toContain('data-testid="improve-plans-kpi"');
    expect(list).toContain('data-testid="improve-plans-list"');
    expect(list).not.toContain("StatCard");
    expect(list).not.toContain('from "@/components/ui/card"');
    expect(list).toContain("useOrgQuery");
    expect(list).toContain("queryKeys.improve.plans");
    expect(list).not.toContain("useState<ImprovementPlan[]>");
    expect(list).not.toContain("loadPlans");
  });

  it("3.2 plan detail Diff/Summary toggle", () => {
    expect(detailBody).toContain('data-testid="plan-review-pane-toggle"');
    expect(detailBody).toContain('setReviewPane("diff")');
    expect(detailBody).toContain('setReviewPane("summary")');
    expect(detailBody).toContain("PlanSummaryPanel");
    expect(detailBody).toContain("DiffViewer");
    expect(detail).toContain("PlanDetailBody");
    expect(summary).toContain("What changes");
    expect(summary).toContain("Evidence");
    expect(summary).toContain("Risk");
    expect(summary).toContain('data-testid="plan-summary-panel"');
  });

  it("3.3 DiffViewer unified/split + keyboard-friendly", () => {
    expect(diff).toContain('data-testid="diff-viewer"');
    expect(diff).toContain('aria-label="Diff layout"');
    expect(diff).toContain("onKeyDown");
    expect(diff).toContain('e.key === "ArrowRight"');
    expect(diff).toContain('e.key === "u"');
    expect(diff).toContain('e.key === "s"');
    expect(diff).toContain('from "@/components/ui/button"');
  });

  it("3.4 approve/reject/snooze use kit Dialog + toast honesty", () => {
    expect(detail).toContain('from "@/components/ui/dialog"');
    expect(detail).toContain('setConfirmAction("approve")');
    expect(detail).toContain('setConfirmAction("reject")');
    expect(detail).toContain('setConfirmAction("snooze")');
    expect(detail).toContain("ConfirmDialog");
    expect(detailHook).toContain("realSuccess");
    expect(detailHook).toContain('status === "pr_opened"');
    expect(detailHook).toContain('status === "promoted"');
    expect(detailHook).toContain('status === "promotion_queued"');
    expect(detailHook).not.toMatch(/toast\.success\(\s*["']Approved/);
    expect(detailHook).toContain("useOrgQuery");
    expect(detailHook).toContain("queryKeys.improve.plan");
    expect(detailHook).toContain("useOrgMutation");
  });

  it("3.5 PlanKindBadge deep links by kind", () => {
    expect(badge).toContain("prompt_update");
    expect(badge).toContain("guardrail_tune");
    expect(badge).toContain("promptHref");
    expect(badge).toContain('"/guardrails"');
    expect(detail).toContain("PlanKindBadge");
    expect(list).toContain("PlanKindBadge");
  });

  it("preserves EmbeddedSurface embed (PageHeader hides via context)", () => {
    const header = read("components/layout/page-header.tsx");
    expect(header).toContain("useEmbeddedSurface");
    expect(list).toContain("PageHeader");
    expect(list).not.toContain('embedded={false}');
  });

  it("runs migrated to RQ for consistency", () => {
    expect(runs).toContain("useOrgQuery");
    expect(runs).toContain("queryKeys.improve.runs");
    expect(runs).not.toContain("useState<ImprovementRun[]>");
  });
});
