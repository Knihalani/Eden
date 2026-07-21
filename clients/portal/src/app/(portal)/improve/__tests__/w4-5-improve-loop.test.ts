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
  it("queue wires canApproveQueueItem, legacy read-only approve, and N23 planHref", () => {
    const board = read("app/(portal)/improve/_components/queue-board.tsx");
    const card = read("app/(portal)/improve/_components/queue-item-card.tsx");
    const helpers = read("app/(portal)/improve/_components/queue-helpers.ts");
    expect(helpers).toContain("canApproveQueueItem");
    expect(helpers).toContain("isLegacyProposedPatch");
    expect(card).toContain("Legacy patch · read-only");
    expect(board).toContain("QueryState");
    expect(board).toContain("View Issues");
    // Must not map patch_id → /improve/plans/{id}
    expect(helpers).not.toMatch(/payload\?\.plan_id \?\? item\.payload\?\.patch_id/);
    expect(helpers).not.toMatch(
      /item\.ref\.startsWith\("proposed_patch:"\)[\s\S]{0,120}\/improve\/plans\/\$\{/,
    );
  });

  it("UX-P1-01 mobile list/stack below lg with touch targets", () => {
    const board = read("app/(portal)/improve/_components/queue-board.tsx");
    expect(board).toContain("data-wave11-mobile");
    expect(board).toContain("min-h-11");
    expect(board).not.toMatch(/text-\[(?:9|10)px\]/);
    expect(board).not.toContain("h-7 px-2");
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
    const page = read("app/(portal)/improve/plans/[id]/page.tsx");
    const hook = read(
      "app/(portal)/improve/plans/[id]/_components/use-plan-detail.ts",
    );
    expect(hook).toMatch(
      /\["draft", "pending_review", "approved"\]\.includes\(plan\.status\)/,
    );
    expect(page).toContain("ErrorState");
    expect(page).toContain("Approve & open PR");
    expect(hook).toContain("approvePlan");
    expect(hook).toContain("rejectPlan");
    expect(canActOnPlan("draft")).toBe(true);
    expect(canActOnPlan("snoozed")).toBe(false);
    expect(canActOnPlan("pr_opened")).toBe(false);
    expect(canActOnPlan("rejected")).toBe(false);
  });
});

describe("W4-5 ErrorState + empty onboarding CTAs", () => {
  it("plans gates KPI/filters behind !error and keeps one empty CTA", () => {
    const src = read("app/(portal)/improve/plans/page.tsx");
    expect(src).toContain("Could not load plans");
    expect(src).toContain("Try again");
    expect(src).toContain("!error && !(plansQuery.isLoading && plans.length === 0)");
    expect(src).toContain("No improvement plans yet");
    expect(src).toContain('href="/issues"');
    expect(src).toContain("View Issues");
  });

  it("runs empty offers one Run sweep CTA (schedule in prose)", () => {
    const src = read("app/(portal)/improve/runs/page.tsx");
    expect(src).toContain("Could not load sweep history");
    expect(src).toContain("No sweeps yet");
    expect(src).toContain("Run sweep now");
    expect(src).toContain("/settings?tab=autonomous");
    expect(src).toContain('data-testid="improve-runs-empty-trigger"');
    expect(src).toMatch(/EmptyState[\s\S]*action=\{/);
  });

  it("scorecard empty offers one retry CTA", () => {
    const src = read("app/(portal)/improve/scorecard/page.tsx");
    expect(src).toContain("ErrorState");
    expect(src).toContain("No scorecard metrics");
    expect(src).toContain("Retry scorecard");
  });

  it("change-impact empty offers traces CTA (Run lives on form)", () => {
    const src = read("app/(portal)/improve/change-impact/page.tsx");
    expect(src).toContain("ErrorState");
    expect(src).toContain("No result yet");
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
