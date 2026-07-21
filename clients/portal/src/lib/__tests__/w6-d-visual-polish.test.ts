/**
 * W6-D — Design tokens, shared form controls, empty/loading consistency.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

describe("W6-D semantic colors tokenized", () => {
  it("model-advisor uses success/error/warning tokens (no emerald/rose/orange Tailwind)", () => {
    const src = [
      read("app/(portal)/optimization/model-advisor/page.tsx"),
      read(
        "app/(portal)/optimization/model-advisor/_components/recommendation-card.tsx",
      ),
      read(
        "app/(portal)/optimization/model-advisor/_components/compare-view.tsx",
      ),
      read(
        "app/(portal)/optimization/model-advisor/_components/project-view.tsx",
      ),
      read(
        "app/(portal)/optimization/model-advisor/_components/advisor-candidates.ts",
      ),
    ].join("\n");
    expect(src).toContain("var(--success)");
    expect(src).toContain("var(--error)");
    expect(src).toContain("var(--warning)");
    expect(src).not.toMatch(/emerald-|rose-|orange-/);
  });

  it("experiments char-diff uses error/success tokens", () => {
    const src = read("app/(portal)/experiments/_components/compare-panel.tsx");
    expect(src).toContain("var(--error-bg)");
    expect(src).toContain("var(--success-bg)");
    expect(src).not.toMatch(/bg-red-|bg-emerald-/);
  });

  it("autonomous-tab enabled icon uses success token", () => {
    const src = read("app/(portal)/settings/_components/autonomous-tab.tsx");
    expect(src).toContain("var(--success)");
    expect(src).not.toMatch(/text-emerald-/);
  });
});

describe("W6-D shared Input/Select/Textarea", () => {
  it("prompts new-entry form uses Input and Textarea", () => {
    const src = read("app/(portal)/prompts/_components/prompts-create-form.tsx");
    expect(src).toContain('from "@/components/ui/input"');
    expect(src).toContain('from "@/components/ui/textarea"');
    expect(src).toContain("<Input");
    expect(src).toContain("<Textarea");
    expect(src).not.toMatch(/<textarea[\s>]/);
  });

  it("labeling review dialog uses Select and Textarea", () => {
    const src = read(
      "app/(portal)/labeling/_components/labeling-review-dialog.tsx",
    );
    expect(src).toContain('from "@/components/ui/select"');
    expect(src).toContain('from "@/components/ui/textarea"');
    expect(src).toContain("<Select");
    expect(src).toContain("<Textarea");
    expect(src).not.toMatch(/<select[\s>]/);
    expect(src).not.toMatch(/<textarea[\s>]/);
  });

  it("signals create panel uses Textarea and Input", () => {
    const src = read("app/(portal)/signals/page.tsx");
    expect(src).toContain('from "@/components/ui/textarea"');
    expect(src).toContain('from "@/components/ui/input"');
    expect(src).toContain("<Textarea");
    expect(src).toContain("<Input");
    expect(src).not.toMatch(/<textarea[\s>]/);
  });
});

describe("W6-D empty/loading consistency", () => {
  it("scorecard empty uses EmptyState with icon; loading uses LoadingSkeleton", () => {
    const src = read("app/(portal)/improve/scorecard/page.tsx");
    expect(src).toContain("EmptyState");
    expect(src).toContain("icon={Trophy}");
    expect(src).toContain("LoadingSkeleton");
    expect(src).not.toContain("Loader2");
  });

  it("improve/runs loading uses LoadingSkeleton; empty uses size lg", () => {
    const src = read("app/(portal)/improve/runs/page.tsx");
    expect(src).toContain("LoadingSkeleton");
    expect(src).toContain('size="lg"');
    expect(src).not.toContain("Loading runs…");
  });
});
