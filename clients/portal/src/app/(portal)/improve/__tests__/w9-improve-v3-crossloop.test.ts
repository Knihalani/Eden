/**
 * Wave 9 — Improve V3 cross-loop hardening.
 * Deep-link matrix, empties (one CTA), onboarding V3, toast honesty,
 * history density, walkthrough, markers.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CROSS_LINK_MATRIX,
  improveHistoryHref,
  improveHref,
  improvePlansHref,
  promptHref,
  promptPlaygroundHref,
} from "@/lib/portal-cross-links";
import { U20_TOAST_MUTATION_SOURCES } from "@/lib/portal-polish";
import { WAVE9_IMPROVE_CROSSLOOP_COMPLETED } from "../_components/improve-constants";

const portalSrc = resolve(__dirname, "../../../../");
const portalRoot = resolve(__dirname, "../../../../../");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

function readRoot(rel: string): string {
  return readFileSync(resolve(portalRoot, rel), "utf8");
}

describe("Wave 9 improve V3 cross-loop", () => {
  it("9.7 marks wave9-improve-crossloop completed", () => {
    expect(WAVE9_IMPROVE_CROSSLOOP_COMPLETED).toBe(true);
    const page = read("app/(portal)/improve/page.tsx");
    expect(page).toContain('data-wave9-improve-crossloop="completed"');
    expect(existsSync(resolve(portalRoot, ".wave9-improve-critic.md"))).toBe(true);
  });

  it("9.1 deep-link helpers stay coherent with V3 IA", () => {
    expect(improveHref("iss-1")).toBe("/improve?issue=iss-1");
    expect(improveHref()).toBe("/improve");
    expect(promptHref("support_reply")).toBe("/prompts?prompt=support_reply");
    expect(promptPlaygroundHref("support_reply")).toBe(
      "/evals?tab=playgrounds&prompt=support_reply",
    );
    expect(improvePlansHref("plan-9")).toBe("/improve/plans/plan-9");
    expect(improvePlansHref()).toBe("/improve?tab=plans");
    expect(improveHistoryHref()).toBe("/improve?tab=history");

    const rows = CROSS_LINK_MATRIX.map((r) => `${r.from}->${r.to}`);
    expect(rows).toContain("issue->improve");
    expect(rows).toContain("trace->improve");
    expect(rows).toContain("alert->improve");
    expect(rows).toContain("prompt->playground");
    expect(rows).toContain("prompt->improve");
    expect(rows).toContain("artifact->improve");
  });

  it("9.1 call sites: Issues, Traces, Alerts, Prompts→playground", () => {
    const issueHeader = read("app/(portal)/issues/_components/issue-detail-header.tsx");
    expect(issueHeader).toContain("improveHref");

    const traces = read("components/trace-viewer/UnifiedTopBar.tsx");
    expect(traces).toContain("improveHref");
    expect(traces).toContain("Open Improve");
    expect(traces).toContain('data-wave9-improve-crossloop=');

    const alerts = read("app/(portal)/alerts/_components/alerts-detail-panel.tsx");
    expect(alerts).toContain("improveHref");
    expect(alerts).toContain('data-testid="alerts-detail-improve-link"');

    const editor = read("app/(portal)/prompts/_components/prompts-editor.tsx");
    expect(editor).toContain("promptPlaygroundHref(name)");

    const playgroundHook = read(
      "app/(portal)/playgrounds/_components/use-playgrounds-page.ts",
    );
    expect(playgroundHook).toContain('searchParams.get("prompt")');
    expect(playgroundHook).toContain("source_prompt");
  });

  it("9.2 onboarding checklist aligns to V3 (Queue + Prompts)", () => {
    const onboard = read("app/(portal)/onboarding/improvement-loop.tsx");
    expect(onboard).toContain('data-wave9-improve-crossloop="onboarding"');
    expect(onboard).toContain('href="/prompts"');
    expect(onboard).toContain("master–detail");

    const learn = readFileSync(
      resolve(portalSrc, "../../../src/eden/api/routes/learn.py"),
      "utf8",
    );
    expect(learn).toContain('"id": "queue"');
    expect(learn).toContain('"href": "/improve"');
    expect(learn).toContain('"id": "prompts"');
    expect(learn).toContain('"href": "/prompts"');
  });

  it("9.3 Improve-group empties use one primary CTA", () => {
    const plans = read("app/(portal)/improve/plans/page.tsx");
    expect(plans).toContain("View Issues");
    expect(plans).not.toContain("Docs quickstart");

    const runs = read("app/(portal)/improve/runs/page.tsx");
    expect(runs).toContain('data-testid="improve-runs-empty-trigger"');
    expect(runs).not.toMatch(
      /EmptyState[\s\S]*Configure schedule[\s\S]*View plans/,
    );

    const artifacts = read("app/(portal)/artifacts/_components/artifacts-list.tsx");
    expect(artifacts).toContain("View Agent Issues");
    expect(artifacts).not.toContain("Docs quickstart");

    const scorecard = read("app/(portal)/improve/scorecard/page.tsx");
    expect(scorecard).toContain("Retry scorecard");
    expect(scorecard).not.toMatch(
      /EmptyState[\s\S]*Retry scorecard[\s\S]*Back to Improve[\s\S]*Change impact/,
    );

    const changeImpact = read("app/(portal)/improve/change-impact/page.tsx");
    expect(changeImpact).toContain('href="/traces"');
    expect(changeImpact).not.toMatch(
      /EmptyState[\s\S]*Open Traces[\s\S]*Improve queue/,
    );
  });

  it("9.4 toast / mutation approve honesty", () => {
    const queue = read("app/(portal)/improve/_components/use-improve-queue.ts");
    expect(queue).toContain("realSuccess");
    expect(queue).not.toMatch(/toast\.success\(\s*["']Approved["']\s*\)/);

    const plan = read(
      "app/(portal)/improve/plans/[id]/_components/use-plan-detail.ts",
    );
    expect(plan).toContain("realSuccess");
    expect(plan).not.toMatch(/toast\.success\(\s*["']Approved["']\s*\)/);

    expect(U20_TOAST_MUTATION_SOURCES["playground.run"]).toContain(
      "use-playgrounds-page.ts",
    );
    expect(U20_TOAST_MUTATION_SOURCES["playground.compare"]).toContain(
      "use-playgrounds-page.ts",
    );
    expect(U20_TOAST_MUTATION_SOURCES["improve.approve"]).toContain(
      "use-improve-queue.ts",
    );
    expect(U20_TOAST_MUTATION_SOURCES["plan.approve"]).toContain(
      "use-plan-detail.ts",
    );
  });

  it("9.5 history/runs density + trigger run", () => {
    const runs = read("app/(portal)/improve/runs/page.tsx");
    expect(runs).toContain('data-wave9-improve-crossloop="history"');
    expect(runs).toContain('data-testid="improve-runs-trigger"');
    expect(runs).toContain("useOrgQuery");
    expect(runs).toContain("queryKeys.improve.runs");
    expect(runs).toContain("triggerRun");
    expect(runs).toContain("px-space-2 py-space-1");
  });

  it("9.6 walkthrough documents Improve V3", () => {
    const walk = readRoot("WALKTHROUGH-UX.md");
    expect(walk).toContain("Improve V3");
    expect(walk).toContain("master–detail");
    expect(walk).toContain("Issues · Artifacts · Ledger · Prompts");
    expect(walk).toContain("?prompt=");
  });

  it("hub related strip stays Issues · Artifacts · Ledger · Prompts", () => {
    const constants = read(
      "app/(portal)/improve/_components/improve-constants.ts",
    );
    expect(constants).toContain('label: "Issues"');
    expect(constants).toContain('label: "Artifacts"');
    expect(constants).toContain('label: "Ledger"');
    expect(constants).toContain('label: "Prompts"');
    expect(constants).not.toContain("/improve/scorecard");
    expect(constants).not.toContain("/guardrails");
    expect(constants).not.toContain("/optimization");
  });
});
