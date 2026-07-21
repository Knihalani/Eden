/**
 * W6 motion + a11y (UX-P0-15) — source locks for focus rings,
 * reduced-motion, 2.4.11 scroll clearance, and axe route expansion.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  U20_CORE_AXE_ROUTES,
  U20_SERIOUS_AXE_ROUTES,
} from "@/lib/portal-polish";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";

const ROOT = resolve(__dirname, "../../..");
const src = (rel: string) => readFileSync(resolve(ROOT, "src", rel), "utf8");

describe("W6 Button / Tabs focus-visible + CTA floor", () => {
  it("Button uses FOCUS_RING_CLASS and min-h-11 default size", () => {
    const button = src("components/ui/button.tsx");
    expect(button).toContain('from "./focus-ring"');
    expect(button).toContain("FOCUS_RING_CLASS");
    expect(button).toContain("min-h-11");
    expect(button).not.toMatch(/focus:outline-none focus:ring-2/);
  });

  it("Tabs triggers/content use FOCUS_RING_CLASS", () => {
    const tabs = src("components/ui/tabs.tsx");
    expect(tabs).toContain("FOCUS_RING_CLASS");
    expect(tabs).not.toMatch(/focus-visible:ring-\[var\(--accent\)\]/);
  });
});

describe("W6 MobileBottomNav a11y", () => {
  it("More label uses text-2xs and FOCUS_RING on chrome controls", () => {
    const mobile = src("components/portal-os/MobileBottomNav.tsx");
    expect(mobile).toContain("FOCUS_RING_CLASS");
    expect(mobile).toContain("text-2xs");
    expect(mobile).not.toContain("text-[10px]");
    expect(mobile).toMatch(/Agents, ops tools/i);
  });
});

describe("W6 reduced motion + 2.4.11 scroll clearance", () => {
  it("globals.css keeps prefers-reduced-motion and scroll-margin for sticky chrome", () => {
    const css = src("app/globals.css");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).toContain("scroll-padding-top");
    expect(css).toContain("scroll-padding-bottom");
    expect(css).toContain("#main-content :focus-visible");
    expect(css).toContain("scroll-margin-top");
  });

  it("MotionProvider uses reducedMotion=user", () => {
    const motion = src("components/providers/motion-provider.tsx");
    expect(motion).toContain('reducedMotion="user"');
  });

  it("hot paths (dashboard / traces / issues) do not import framer-motion", () => {
    for (const rel of [
      "app/(portal)/dashboard/page.tsx",
      "app/(portal)/traces/page.tsx",
      "app/(portal)/issues/page.tsx",
    ]) {
      const page = src(rel);
      expect(page).not.toMatch(/from ["']framer-motion["']/);
      expect(page).not.toMatch(/from ["']motion\/react["']/);
    }
  });
});

describe("W6 axe route expansion", () => {
  it("includes agents + settings and gates serious on traces/improve", () => {
    expect(U20_CORE_AXE_ROUTES).toEqual(
      expect.arrayContaining(["/agents", "/settings", "/evals", "/alerts"]),
    );
    expect([...U20_SERIOUS_AXE_ROUTES]).toEqual(["/traces", "/improve", "/evals", "/issues"]);
    const script = readFileSync(resolve(ROOT, "scripts/audit-a11y.cjs"), "utf8");
    expect(script).toContain('"/agents"');
    expect(script).toContain('"/settings"');
    expect(script).toContain("SERIOUS_GATE_ROUTES");
    expect(FOCUS_RING_CLASS).toContain("focus-visible");
  });
});
