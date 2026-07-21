/**
 * Wave 2 — Improve V3 queue hub (master–detail).
 * Extends/replaces W7/W8 queue contracts: peel ≤400, ViewsMenu views,
 * DetailPanelShell, RQ unify, ?issue=, EmbeddedSurface plans/history.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { improveHref } from "@/lib/portal-cross-links";
import { queueItemMatchesIssue } from "@/lib/improve-queue-issue";
import type { ImproveQueueItem } from "@/lib/api";
import {
  IMPROVE_QUEUE_COLUMNS,
  IMPROVE_QUEUE_VIEW_PRESETS,
  WAVE2_IMPROVE_QUEUE_COMPLETED,
  queueColumnId,
} from "../_components/improve-constants";
import {
  canApproveQueueItem,
  itemsForView,
  planHref,
  primaryActionForItem,
} from "../_components/queue-helpers";

const portalSrc = resolve(__dirname, "../../../../");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

function lineCount(rel: string): number {
  return read(rel).split("\n").length;
}

function item(partial: Partial<ImproveQueueItem>): ImproveQueueItem {
  return {
    ref: "issue:x",
    item_type: "issue",
    title: "t",
    column: "needs_you",
    severity: "medium",
    status: "open",
    ...partial,
  };
}

describe("Wave 2 improve V3 queue hub", () => {
  const page = read("app/(portal)/improve/page.tsx");
  const board = read("app/(portal)/improve/_components/queue-board.tsx");
  const hook = read("app/(portal)/improve/_components/use-improve-queue.ts");
  const constants = read("app/(portal)/improve/_components/improve-constants.ts");

  it("2.10 marks wave2-improve-queue completed", () => {
    expect(WAVE2_IMPROVE_QUEUE_COMPLETED).toBe(true);
    expect(constants).toContain("WAVE2_IMPROVE_QUEUE_COMPLETED = true");
    expect(page).toContain('data-wave2-improve-queue="completed"');
    expect(page).toContain("WAVE7_IMPROVE_COMPLETED = true");
    expect(page).toContain("WAVE8_IMPROVE_COMPLETED = true");
    expect(page).toContain('data-wave7-improve="completed"');
    expect(page).toContain('data-wave8-improve="completed"');
  });

  it("2.1 peels shell into _components", () => {
    for (const rel of [
      "app/(portal)/improve/_components/queue-board.tsx",
      "app/(portal)/improve/_components/queue-item-card.tsx",
      "app/(portal)/improve/_components/queue-detail-panel.tsx",
      "app/(portal)/improve/_components/improve-related-strip.tsx",
      "app/(portal)/improve/_components/use-improve-queue.ts",
      "app/(portal)/improve/_components/queue-helpers.ts",
    ]) {
      expect(existsSync(resolve(portalSrc, rel)), rel).toBe(true);
    }
    expect(page).toContain("QueueBoard");
    expect(page).toContain("useImproveQueue");
    expect(page).toContain("ImproveRelatedStrip");
  });

  it("2.8 hub shell ≤400 LOC", () => {
    expect(lineCount("app/(portal)/improve/page.tsx")).toBeLessThanOrEqual(400);
  });

  it("2.2 master–detail + ViewsMenu (not kanban walls)", () => {
    const detail = read(
      "app/(portal)/improve/_components/queue-detail-panel.tsx",
    );
    expect(board).toContain("ViewsMenu");
    expect(board).toContain("QueueDetailPanel");
    expect(detail).toContain("DetailPanelShell");
    expect(board).toContain("IMPROVE_QUEUE_VIEW_PRESETS");
    expect(board).not.toContain("lg:grid-cols-3");
    expect(board).not.toContain("2xl:grid-cols-5");
    expect(page).not.toContain("lg:grid-cols-3");
    expect(IMPROVE_QUEUE_COLUMNS).toHaveLength(3);
    expect(IMPROVE_QUEUE_VIEW_PRESETS.map((p) => p.id)).toEqual([
      "needs_you",
      "in_progress",
      "verify",
    ]);
    expect(queueColumnId("urgent")).toBe("needs_you");
    expect(queueColumnId("proposed")).toBe("needs_you");
    expect(queueColumnId("autonomous")).toBe("in_progress");
    expect(queueColumnId("verify")).toBe("verify");
  });

  it("2.3 unifies hub React Query via useImproveQueue", () => {
    expect(hook).toContain("useOrgQuery");
    expect(hook).toContain("queryKeys.improve.queue");
    expect(hook).toContain("queryKeys.improve.featureGate");
    expect(hook).toContain("useOrgMutation");
    expect(hook).not.toContain("useState(true)");
    expect(page).not.toContain("improveApi.queue");
  });

  it("2.4 embedded Plans/History without double PageHeader chrome", () => {
    expect(page).toContain("EmbeddedSurface");
    expect(page).toContain('value="plans"');
    expect(page).toContain('value="history"');
    const plans = read("app/(portal)/improve/plans/page.tsx");
    const runs = read("app/(portal)/improve/runs/page.tsx");
    expect(plans).toContain("PageHeader");
    expect(runs).toContain("PageHeader");
    const header = read("components/layout/page-header.tsx");
    expect(header).toContain("useEmbeddedSurface");
    expect(header).toContain("hideChrome");
  });

  it("2.5 empty / filter-empty use one primary CTA", () => {
    expect(board).toContain('href="/issues"');
    expect(board).toContain("View Issues");
    expect(board).toContain("Clear filter");
    expect(board).toContain("ImproveFeatureDisabledState");
    const emptyBlock = board.slice(
      board.indexOf("Nothing in the queue"),
      board.indexOf("Nothing in the queue") + 400,
    );
    expect(emptyBlock.match(/<Button/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it("2.6 preserves ?issue= + auto-open single N23 plan", () => {
    expect(improveHref("iss-42")).toBe("/improve?issue=iss-42");
    expect(hook).toContain('searchParams.get("issue")');
    expect(hook).toContain("queueItemMatchesIssue");
    expect(hook).toContain("didAutoOpenPlan");
    expect(hook).toContain("router.replace");
    expect(board).toContain('data-testid="improve-issue-filter"');
    expect(
      queueItemMatchesIssue(item({ ref: "issue:abc" }), "abc"),
    ).toBe(true);
    expect(
      queueItemMatchesIssue(
        item({ ref: "closed_loop:1", payload: { issue_id: "abc" } }),
        "abc",
      ),
    ).toBe(true);
    expect(
      queueItemMatchesIssue(
        item({
          ref: "improvement_plan:p1",
          payload: { source_ref: "issue:abc" },
        }),
        "abc",
      ),
    ).toBe(true);
  });

  it("2.7 mobile uses DetailPanelShell drawer (<1280)", () => {
    const detail = read("app/(portal)/improve/_components/queue-detail-panel.tsx");
    expect(detail).toContain("DetailPanelShell");
    expect(detail).toContain("mobileDrawer");
    expect(detail).toContain('data-testid="improve-queue-primary-cta"');
  });

  it("related strip stays Issues · Artifacts · Ledger · Prompts", () => {
    const strip = read(
      "app/(portal)/improve/_components/improve-related-strip.tsx",
    );
    expect(strip).toContain('data-testid="improve-related-strip"');
    expect(constants).toContain('href: "/prompts"');
    expect(constants).not.toContain("/improve/scorecard");
    expect(page).not.toContain("PATH_LINKS");
    expect(page).not.toContain("<CrossLinkBar");
  });

  it("primary CTA helpers: Approve / Open plan / Promote", () => {
    expect(
      primaryActionForItem(
        item({
          ref: "improvement_plan:p1",
          column: "needs_you",
        }),
      ).kind,
    ).toBe("approve");
    expect(
      canApproveQueueItem(
        item({ ref: "improvement_plan:p1", column: "needs_you" }),
      ),
    ).toBe(true);
    expect(
      planHref(
        item({
          ref: "improvement_plan:abc",
          column: "verify",
        }),
      ),
    ).toBe("/improve/plans/abc");
    expect(
      primaryActionForItem(
        item({ ref: "promotion:1", item_type: "promotion", column: "verify" }),
      ),
    ).toEqual({ kind: "promote", label: "Promote", href: "/artifacts" });
    expect(
      itemsForView(
        [
          item({ ref: "a", column: "needs_you" }),
          item({ ref: "b", column: "autonomous" }),
          item({ ref: "c", column: "verify" }),
        ],
        "in_progress",
      ).map((i) => i.ref),
    ).toEqual(["b"]);
  });
});
