/**
 * Wave 2 — design system freeze contracts.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buttonVariants } from "@/components/ui/button";

const ROOT = resolve(__dirname, "../../..");
const src = (rel: string) => readFileSync(resolve(ROOT, "src", rel), "utf8");

describe("W2 design system freeze", () => {
  it("collapses secondary to quiet and aliases danger → destructive", () => {
    const secondary = buttonVariants({ variant: "secondary" });
    const destructive = buttonVariants({ variant: "destructive" });
    const danger = buttonVariants({ variant: "danger" });

    expect(secondary).toContain("bg-[var(--bg-secondary)]");
    expect(secondary).not.toContain("bg-[var(--accent)]");
    expect(danger).toBe(destructive);
    expect(destructive).toContain("bg-[var(--error)]");
  });

  it("exports FilterBar, Wizard, ErrorBoundary from ui barrel", () => {
    const barrel = src("components/ui/index.ts");
    expect(barrel).toContain('from "./filter-bar"');
    expect(barrel).toContain('from "./wizard"');
    expect(barrel).toContain('from "./error-boundary"');
  });

  it("StatusBadge wraps Badge; Tag wraps Badge", () => {
    expect(src("components/ui/status-badge.tsx")).toContain('from "./badge"');
    expect(src("components/ui/status-badge.tsx")).toContain("<Badge");
    expect(src("components/ui/tag.tsx")).toContain('from "./badge"');
    expect(src("components/ui/tag.tsx")).toContain("<Badge");
  });

  it("bans raw Radix Dialog in settings delete/transfer/security", () => {
    for (const rel of [
      "app/(portal)/settings/_components/delete-org-dialog.tsx",
      "app/(portal)/settings/_components/transfer-ownership-dialog.tsx",
      "app/(portal)/settings/_components/security-tab.tsx",
    ]) {
      const body = src(rel);
      expect(body).not.toContain('@radix-ui/react-dialog');
      expect(body).toContain('@/components/ui/dialog');
    }
  });

  it("ScoresTab and portal not-found use kit Button (no raw accent CTA)", () => {
    const scores = src("app/(portal)/observability/ScoresTab.tsx");
    expect(scores).toContain('@/components/ui/button');
    expect(scores).not.toMatch(/bg-\[var\(--accent\)\]/);
    expect(scores).toContain("EmptyState");

    const notFound = src("app/(portal)/not-found.tsx");
    expect(notFound).toContain('@/components/ui/button');
    expect(notFound).not.toMatch(/bg-\[var\(--accent\)\]/);
  });

  it("Input uses secondary fill and 28–32px height", () => {
    const input = src("components/ui/input.tsx");
    expect(input).toContain("bg-[var(--bg-secondary)]");
    expect(input).toMatch(/h-8/);
  });

  it("DESIGN.md documents kit grammar section", () => {
    const design = readFileSync(resolve(ROOT, "DESIGN.md"), "utf8");
    expect(design).toContain("## 14. Kit grammar (Wave 1 V2 freeze)");
    expect(design).toContain("Visual checklist");
  });
});
