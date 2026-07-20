/**
 * Wave 4.5 — Improve loop (N23): approve wiring, ErrorState, empty onboarding CTAs.
 *
 * - Queue must not deep-link legacy Cat 23 patch IDs into /improve/plans/{id}
 * - Approve only for improvement_plan:/closed_loop: refs; blocked/legacy disabled
 * - Plan detail canAct limited to draft|pending_review|approved (no snoozed 409s)
 * - Plans/runs/scorecard/change-impact: ErrorState + empty CTAs; no false-zero KPIs
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

type QueueItemLike = {
  ref: string;
  item_type: string;
  column: string;
  source?: string;
  blocked_reason?: string | null;
  payload?: Record<string, unknown>;
  href?: string | null;
};

function isLegacyProposedPatch(item: QueueItemLike): boolean {
  return (
    item.ref.startsWith("proposed_patch:") || item.source === "proposed_patches"
  );
}

function planHref(item: QueueItemLike): string | null {
  if (item.ref.startsWith("improvement_plan:")) {
    const id = item.ref.split(":").slice(1).join(":");
    return id ? `/improve/plans/${id}` : null;
  }
  const planId = item.payload?.plan_id;
  if (
    typeof planId === "string" &&
    planId &&
    (item.source === "improvement_plans" || item.item_type === "improvement_plan")
  ) {
    return `/improve/plans/${planId}`;
  }
  if (isLegacyProposedPatch(item) || item.href?.startsWith("/pr-suggestions")) {
    return "/improve/plans";
  }
  return item.href ?? null;
}

function canApproveQueueItem(item: QueueItemLike): boolean {
  if (item.blocked_reason) return false;
  if (item.column !== "proposed" && item.column !== "needs_you") return false;
  return (
    item.ref.startsWith("closed_loop:") || item.ref.startsWith("improvement_plan:")
  );
}

function canActOnPlan(status: string): boolean {
  return ["draft", "pending_review", "approved"].includes(status);
}

describe("W4-5 improve queue approve + href honesty", () => {
  it("page wires canApproveQueueItem, legacy read-only approve, and N23 planHref", () => {
    const src = read("app/(portal)/improve/page.tsx");
    expect(src).toContain("canApproveQueueItem");
    expect(src).toContain("isLegacyProposedPatch");
    expect(src).toContain("Legacy Cat 23 patches are read-only");
    expect(src).toContain("Approve disabled:");
    expect(src).toContain("QueryState");
    expect(src).toContain("Docs quickstart");
    expect(src).toContain("/settings?tab=api-keys");
    // Must not map patch_id → /improve/plans/{id}
    expect(src).not.toMatch(/payload\?\.plan_id \?\? item\.payload\?\.patch_id/);
    expect(src).not.toMatch(
      /item\.ref\.startsWith\("proposed_patch:"\)[\s\S]{0,120}\/improve\/plans\/\$\{/,
    );
  });

  it("UX-P1-01 mobile list/stack below lg with touch targets", () => {
    const src = read("app/(portal)/improve/page.tsx");
    expect(src).toContain("lg:hidden");
    expect(src).toMatch(/hidden[\s\S]{0,40}lg:grid/);
    expect(src).toContain("min-h-11");
    expect(src).not.toMatch(/text-\[(?:9|10)px\]/);
    expect(src).not.toContain("h-7 px-2");
  });

  it("N23 refs deep-link; legacy proposed_patch goes to inbox only", () => {
    expect(
      planHref({
        ref: "improvement_plan:abc-123",
        item_type: "improvement_plan",
        column: "proposed",
        source: "improvement_plans",
      }),
    ).toBe("/improve/plans/abc-123");

    expect(
      planHref({
        ref: "proposed_patch:legacy-uuid",
        item_type: "proposed_patch",
        column: "needs_you",
        source: "proposed_patches",
        payload: { patch_id: "legacy-uuid" },
        href: "/pr-suggestions",
      }),
    ).toBe("/improve/plans");

    expect(
      planHref({
        ref: "other:1",
        item_type: "proposed_patch",
        column: "needs_you",
        payload: { patch_id: "legacy-uuid" },
      }),
    ).toBeNull();
  });

  it("approve only for live refs; blocked + legacy cannot approve", () => {
    expect(
      canApproveQueueItem({
        ref: "improvement_plan:p1",
        item_type: "improvement_plan",
        column: "proposed",
      }),
    ).toBe(true);
    expect(
      canApproveQueueItem({
        ref: "closed_loop:a1",
        item_type: "closed_loop",
        column: "needs_you",
      }),
    ).toBe(true);
    expect(
      canApproveQueueItem({
        ref: "improvement_plan:p1",
        item_type: "improvement_plan",
        column: "proposed",
        blocked_reason: "HIPAA observe mode — approve disabled",
      }),
    ).toBe(false);
    expect(
      canApproveQueueItem({
        ref: "proposed_patch:legacy",
        item_type: "proposed_patch",
        column: "needs_you",
        source: "proposed_patches",
      }),
    ).toBe(false);
  });
});

describe("W4-5 plan detail canAct + ErrorState", () => {
  it("limits canAct to draft|pending_review|approved", () => {
    const src = read("app/(portal)/improve/plans/[id]/page.tsx");
    expect(src).toMatch(
      /\["draft", "pending_review", "approved"\]\.includes\(plan\.status\)/,
    );
    expect(src).toContain("ErrorState");
    expect(src).toContain("Approve & open PR");
    expect(src).toContain("approvePlan");
    expect(src).toContain("rejectPlan");
    expect(canActOnPlan("draft")).toBe(true);
    expect(canActOnPlan("snoozed")).toBe(false);
    expect(canActOnPlan("pr_opened")).toBe(false);
    expect(canActOnPlan("rejected")).toBe(false);
  });
});

describe("W4-5 ErrorState + empty onboarding CTAs", () => {
  it("plans gates KPI/filters behind !error and keeps empty CTAs", () => {
    const src = read("app/(portal)/improve/plans/page.tsx");
    expect(src).toContain("Could not load plans");
    expect(src).toContain("Try again");
    expect(src).toMatch(/\{\/\* Gate KPI\/filters behind !error/);
    expect(src).toMatch(/!error \? \(\s*<>/);
    expect(src).toContain("No improvement plans yet");
    expect(src).toContain("/settings?tab=api-keys");
    expect(src).toContain("/settings?tab=autonomous");
    expect(src).toContain("Docs quickstart");
  });

  it("runs empty offers Run sweep + schedule + plans CTAs", () => {
    const src = read("app/(portal)/improve/runs/page.tsx");
    expect(src).toContain("Could not load sweep history");
    expect(src).toContain("No sweeps yet");
    expect(src).toContain("Run sweep now");
    expect(src).toContain("/settings?tab=autonomous");
    expect(src).toContain("/improve/plans");
    expect(src).toMatch(/EmptyState[\s\S]*action=\{/);
  });

  it("scorecard empty offers retry + improve links", () => {
    const src = read("app/(portal)/improve/scorecard/page.tsx");
    expect(src).toContain("ErrorState");
    expect(src).toContain("No scorecard metrics");
    expect(src).toContain("Retry scorecard");
    expect(src).toContain('href="/improve"');
    expect(src).toContain('href="/improve/change-impact"');
  });

  it("change-impact empty offers Generate preview + traces CTA", () => {
    const src = read("app/(portal)/improve/change-impact/page.tsx");
    expect(src).toContain("ErrorState");
    expect(src).toContain("No preview yet");
    expect(src).toContain("Generate preview");
    expect(src).toContain('href="/traces"');
    expect(src).toMatch(/!report && !error && !busy/);
  });

  it("online-scoring keeps ErrorState + Create rule empty CTA", () => {
    const src = read("app/(portal)/improve/online-scoring/page.tsx");
    expect(src).toContain("Could not load scoring rules");
    expect(src).toContain("No online scoring rules yet");
    expect(src).toContain("Create rule");
  });
});

describe("W4-5 cockpit N23 item_type honesty", () => {
  it("aggregator labels N23 rows improvement_plan not proposed_patch", () => {
    const agg = readFileSync(
      resolve(portalSrc, "../../../src/eden/improvement/cockpit_aggregator.py"),
      "utf8",
    );
    expect(agg).toContain('item_type="improvement_plan"');
    expect(agg).toContain('href="/improve/plans"');
    // Legacy source still uses proposed_patch item_type.
    expect(agg).toMatch(
      /_from_proposed_patches[\s\S]*item_type="proposed_patch"/,
    );
  });
});
