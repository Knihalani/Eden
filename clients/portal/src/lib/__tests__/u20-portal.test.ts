import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  U20_CORE_AXE_ROUTES,
  U20_EMPTY_COPY,
  U20_MOTION_CLASSES,
  U20_TOAST_MUTATIONS,
} from "@/lib/portal-polish";

const ROOT = resolve(__dirname, "../../..");

describe("U20 core axe routes", () => {
  it("defines the expanded GA polish surfaces", () => {
    expect(U20_CORE_AXE_ROUTES).toEqual([
      "/dashboard",
      "/traces",
      "/issues",
      "/artifacts",
      "/playgrounds",
      "/evals",
      "/improve",
      "/alerts",
      "/agents",
      "/settings",
    ]);
  });

  it("matches scripts/audit-a11y.cjs route list", () => {
    const script = readFileSync(resolve(ROOT, "scripts/audit-a11y.cjs"), "utf8");
    for (const route of U20_CORE_AXE_ROUTES) {
      expect(script).toContain(`"${route}"`);
    }
  });
});

describe("U20 microcopy voice (Gap 4.8)", () => {
  it("uses calm copy without exclamation marks", () => {
    for (const text of Object.values(U20_EMPTY_COPY)) {
      expect(text).not.toMatch(/!/);
      expect(text.length).toBeGreaterThan(20);
    }
  });
});

describe("U20 motion tokens", () => {
  it("declares allowed motion utility classes in globals.css", () => {
    const css = readFileSync(resolve(ROOT, "src/app/globals.css"), "utf8");
    for (const cls of U20_MOTION_CLASSES) {
      expect(css).toContain(`.${cls}`);
    }
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).toContain(".panel-enter,\n  .live-append-pulse");
  });
});

describe("U20 badge unification", () => {
  it("keeps issue badges as re-exports from status-badge", () => {
    const src = readFileSync(
      resolve(ROOT, "src/app/(portal)/issues/_components/issue-badges.tsx"),
      "utf8",
    );
    expect(src).toContain('IssuePriorityBadge as IssueSeverityBadge');
    expect(src).toContain('IssueWorkflowBadge as StatusBadge');
    expect(src).not.toMatch(/function IssueSeverityBadge/);
  });

  it("defines IssuePriorityBadge only in status-badge.tsx", () => {
    const badge = readFileSync(resolve(ROOT, "src/components/ui/status-badge.tsx"), "utf8");
    expect(badge).toContain("export function IssuePriorityBadge");
    expect(badge).toContain("export function IssueWorkflowBadge");
  });
});

describe("U20 toast mutation registry", () => {
  it("lists core mutation keys for audit", () => {
    expect(U20_TOAST_MUTATIONS).toContain("artifact.promote");
    expect(U20_TOAST_MUTATIONS).toContain("playground.run");
    expect(U20_TOAST_MUTATIONS).toContain("playground.compare");
    expect(U20_TOAST_MUTATIONS.length).toBeGreaterThanOrEqual(10);
  });

  it("wires artifact and promotion toasts in page sources", () => {
    const artifacts = readFileSync(
      resolve(ROOT, "src/app/(portal)/artifacts/_components/use-artifacts-page.ts"),
      "utf8",
    );
    expect(artifacts).toContain('toast.success("Artifact promoted")');
    expect(artifacts).toContain('toast.success("Shadow artifact drafted")');

    const promotions = readFileSync(
      resolve(ROOT, "src/app/(portal)/improve/_components/use-improve-queue.ts"),
      "utf8",
    );
    expect(promotions).toContain("Promotion queued");
    expect(promotions).toContain("toast.success");
  });
});

describe("U20 skip link", () => {
  it("is present in AppShell", () => {
    const shell = readFileSync(resolve(ROOT, "src/components/portal-os/AppShell.tsx"), "utf8");
    expect(shell).toContain('href="#main-content"');
    expect(shell).toContain('id="main-content"');
  });
});
