/**
 * Wave 26 — DELETE F22 + N20 handoff (portal contracts).
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const src = (rel: string) => readFileSync(resolve(ROOT, "src", rel), "utf8");
const py = (rel: string) =>
  readFileSync(resolve(ROOT, "../../src", rel), "utf8");
const docs = (rel: string) =>
  readFileSync(resolve(ROOT, "../../docs", rel), "utf8");

describe("W26 F22 deleted", () => {
  it("removes portal /issues/[id]/fix page", () => {
    expect(
      existsSync(resolve(ROOT, "src/app/(portal)/issues/[id]/fix/page.tsx")),
    ).toBe(false);
  });

  it("redirects /fix to issue handoff", () => {
    const cfg = src("../next.config.ts");
    expect(cfg).toContain("/issues/:id/fix");
    expect(cfg).toContain("/issues/:id?tab=handoff");
  });

  it("removes fixChat API clients", () => {
    const api = src("lib/api.ts");
    expect(api).not.toContain("fixChatStream");
    expect(api).not.toContain("fixSession");
    expect(api).not.toContain("/fix/chat");
  });

  it("stamps F22 DELETED in honesty docs", () => {
    const deleted = docs("specs/features/DELETED-FEATURES.md");
    expect(deleted).toMatch(/F22.*DELETED|DELETED.*F22/i);
    const gt = docs("specs/CODEBASE-GROUND-TRUTH.md");
    expect(gt).toMatch(/F22.*DELETED|Issue fix chat.*DELETED/i);
  });
});

describe("W26 N20 + handoff CTAs", () => {
  it("issue detail exposes handoff CTAs", () => {
    const detail = src("app/(portal)/issues/[id]/page.tsx");
    expect(detail).toContain("View improvement plan");
    expect(detail).toContain("Open in coding agent");
    expect(detail).toContain("Export fixture");
    expect(detail).toContain("coding-agent-handoff");
    expect(detail).not.toContain("fixChatStream");
  });

  it("improve plan page has approve/reject/diff", () => {
    const page = src("app/(portal)/improve/plans/[id]/page.tsx");
    expect(page).toContain("approve");
    expect(page).toContain("reject");
    expect(page).toContain("diff_unified");
  });

  it("backend N20 gates fingerprint and N22", () => {
    const trigger = py("eden/improvement/issue_patch_trigger.py");
    expect(trigger).toContain("fingerprint_below_threshold");
    expect(trigger).toContain("_MIN_FINGERPRINT_COUNT = 5");
    expect(trigger).toContain("_n22_may_propose");
    expect(trigger).toContain("sum_feature_spend_today");
    expect(trigger).not.toContain("issue_fix_chat");
  });

  it("approve returns N01 merge advice + N06", () => {
    const approve = py("eden/improvement/approve.py");
    expect(approve).toContain("n01_verify_pass");
    expect(approve).toContain("merge_advice");
    expect(approve).toContain("AgentAuditLedgerWriter");
    expect(approve).toContain("reject_plan_audited");
  });

  it("migration drops issue_fix_sessions", () => {
    const mig = py(
      "eden/db_migrations/versions/110_w26_drop_issue_fix_sessions.py",
    );
    expect(mig).toContain("DROP TABLE IF EXISTS issue_fix_sessions");
    expect(mig).toContain('down_revision: str = "109_w18_playgrounds"');
  });
});
