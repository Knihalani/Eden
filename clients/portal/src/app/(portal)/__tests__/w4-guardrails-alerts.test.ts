/**
 * Wave 4 — Guardrails + Alerts leaf rewrite.
 * Policies primary; Test = mode; one result surface; Redteam quiet;
 * Alerts feed-only; Rules sheet; Ack/resolve; shells ≤400; BulkActionBar.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

function lineCount(rel: string): number {
  return read(rel).split("\n").length;
}

describe("W4 guardrails job split", () => {
  it("Policies is default primary; Test is a mode tab", () => {
    const page = read("app/(portal)/guardrails/page.tsx");
    const types = read("app/(portal)/guardrails/_components/types.ts");
    expect(types).toContain('GUARDRAILS_PRIMARY_TABS = ["policies", "test"]');
    expect(page).toMatch(/useQueryTab\(\s*"tab",\s*GUARDRAILS_TABS,\s*"policies"/);
    expect(page).toContain('data-testid="guardrails-test-mode-tab"');
    expect(read("app/(portal)/guardrails/_components/guardrails-kpi.tsx")).toContain(
      'data-wave4-guardrails="completed"',
    );
  });

  it("splits monolith into _components; shell ≤400", () => {
    expect(lineCount("app/(portal)/guardrails/page.tsx")).toBeLessThanOrEqual(400);
    for (const rel of [
      "app/(portal)/guardrails/_components/test-tab.tsx",
      "app/(portal)/guardrails/_components/policies-tab.tsx",
      "app/(portal)/guardrails/_components/injections-tab.tsx",
      "app/(portal)/guardrails/_components/pii-tab.tsx",
      "app/(portal)/guardrails/_components/use-guardrails.ts",
    ]) {
      expect(existsSync(resolve(portalSrc, rel))).toBe(true);
    }
  });

  it("kills Test 3-card wall — one progressive result surface", () => {
    const test = read("app/(portal)/guardrails/_components/test-tab.tsx");
    expect(test).toContain('data-testid="guardrails-test-results"');
    expect(test).toContain("activeResultKind");
    expect(test).not.toContain("lg:grid-cols-3");
    expect(test).toContain('data-testid="guardrails-test-mode"');
  });

  it("Redteam quiet entry via More (not peer first-paint tab)", () => {
    const page = read("app/(portal)/guardrails/page.tsx");
    expect(page).toContain('data-testid="guardrails-more"');
    expect(page).toContain('data-testid="guardrails-more-redteam"');
    // First-paint underline triggers are Policies + Test only unless deep-linked
    expect(page).toMatch(/TabsTrigger value="policies"/);
    expect(page).toMatch(/TabsTrigger[\s\S]*value="test"/);
    // Red team tab trigger only when active (deep-link), not always-on peer
    expect(page).toMatch(/activeTab === "redteam"[\s\S]*TabsTrigger value="redteam"/);
  });
});

describe("W4 alerts feed + split", () => {
  it("feed-only first paint; Signals/Rules via More", () => {
    const page = read("app/(portal)/alerts/page.tsx");
    expect(page).toContain('data-wave4-alerts="completed"');
    expect(page).toMatch(/TabsTrigger[^>]*value="feed"/);
    expect(page).not.toMatch(/TabsTrigger[^>]*value="signals"/);
    expect(page).toContain('data-testid="alerts-more-signals"');
    expect(page).toContain('data-testid="alerts-more-rules"');
    expect(page).toContain("AlertRulesSheet");
  });

  it("shell ≤400 with extracted feed/detail/hook", () => {
    expect(lineCount("app/(portal)/alerts/page.tsx")).toBeLessThanOrEqual(400);
    expect(
      existsSync(resolve(portalSrc, "app/(portal)/alerts/_components/alerts-feed.tsx")),
    ).toBe(true);
    expect(
      existsSync(
        resolve(portalSrc, "app/(portal)/alerts/_components/alerts-detail-panel.tsx"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        resolve(portalSrc, "app/(portal)/alerts/_components/use-alerts-page.ts"),
      ),
    ).toBe(true);
  });

  it("detail Ack/resolve is primary CTA before More", () => {
    const detail = read("app/(portal)/alerts/_components/alerts-detail-panel.tsx");
    expect(detail).toContain('data-testid="alerts-detail-ack"');
    expect(detail).toContain('data-action="resolve"');
    expect(detail).toContain("Ack / resolve");
    const ackIdx = detail.indexOf('data-testid="alerts-detail-ack"');
    const moreIdx = detail.indexOf('aria-label="More actions"');
    expect(moreIdx).toBeGreaterThan(ackIdx);
  });

  it("BulkActionBar hides on mobile (FAB collision)", () => {
    const bar = read("components/portal-os/BulkActionBar.tsx");
    expect(bar).toContain("hideOnMobile");
    expect(bar).toContain("hidden lg:flex");
    const page = read("app/(portal)/alerts/page.tsx");
    expect(page).toContain("hideOnMobile");
    expect(page).toContain("bulkBar=");
  });
});

describe("W4 critic artifact", () => {
  it("writes .wave4-critic.md for Guardrails + Alerts", () => {
    const critic = resolve(portalSrc, "../.wave4-critic.md");
    expect(existsSync(critic)).toBe(true);
    const body = readFileSync(critic, "utf8");
    expect(body).toContain("Wave 4");
    expect(body).toMatch(/Guardrails/i);
    expect(body).toMatch(/Alerts/i);
  });
});
