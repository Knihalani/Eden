/**
 * Wave 3 — IA cleanup & route truth exit contracts.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CORE_MOBILE_HREFS,
  CORE_NAV_ITEM_COUNT,
  DEFAULT_SIDEBAR,
} from "@/lib/sidebar-config";
import {
  buildNavCommands,
  collectSidebarHrefs,
  GROUP_LABEL,
} from "@/lib/nav-commands";
import {
  MOBILE_CORE_NAV,
  MOBILE_MORE_LINKS,
} from "@/components/portal-os/MobileBottomNav";
import { HUB_REDIRECT_RULES } from "@/lib/portal-hub-redirect";
import { promotionsHref } from "@/lib/portal-cross-links";
import { isExternalHref } from "@/lib/utils";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";

const ROOT = resolve(__dirname, "../../..");
const nextConfig = readFileSync(resolve(ROOT, "next.config.ts"), "utf8");
const src = (rel: string) => readFileSync(resolve(ROOT, "src", rel), "utf8");

describe("W3 IA — Target nav", () => {
  it("keeps ≤12 core sidebar items and Target IA group ids", () => {
    expect(CORE_NAV_ITEM_COUNT).toBeLessThanOrEqual(12);
    expect(DEFAULT_SIDEBAR.map((g) => g.id)).toEqual([
      "home",
      "observe",
      "evaluate",
      "improve",
      "workspace",
    ]);
    expect(GROUP_LABEL.home).toBe("Home");
    expect(GROUP_LABEL.evaluate).toBe("Evaluate");
    expect(GROUP_LABEL.improve).toBe("Improve");
  });

  it("drops dual top-level Promotions and Signals from sidebar", () => {
    const ids = DEFAULT_SIDEBAR.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).not.toContain("promotions");
    expect(ids).not.toContain("signals");
    expect(ids).toContain("ledger");
    expect(ids).toContain("alerts");
  });

  it("mobile core five matches desktop primary path", () => {
    expect(MOBILE_CORE_NAV.map((i) => i.href)).toEqual([...CORE_MOBILE_HREFS]);
    expect(MOBILE_CORE_NAV).toHaveLength(5);
    expect(MOBILE_MORE_LINKS.every((l) => l.href !== "/promotions")).toBe(true);
    expect(MOBILE_MORE_LINKS.some((l) => l.href === "/ledger?tab=promotions")).toBe(
      true,
    );
  });
});

describe("W3 IA — dual routes retired", () => {
  it("redirects observability / promotions / predict / analytics orphans", () => {
    expect(nextConfig).toContain('source: "/observability"');
    expect(nextConfig).toContain('destination: "/traces"');
    expect(nextConfig).toContain('source: "/promotions"');
    expect(nextConfig).toContain('destination: "/ledger?tab=promotions"');
    expect(nextConfig).toContain('source: "/optimization/predict"');
    expect(nextConfig).toContain('destination: "/optimization?tab=forecast"');
    expect(HUB_REDIRECT_RULES["/promotions"]).toEqual({
      destination: "/ledger",
      tab: "promotions",
    });
    expect(HUB_REDIRECT_RULES["/optimization/predict"]).toEqual({
      destination: "/optimization",
      tab: "forecast",
    });
    expect(promotionsHref()).toBe("/ledger?tab=promotions");
  });

  it("observability landing is a hard redirect stub", () => {
    const page = src("app/(portal)/observability/page.tsx");
    expect(page).toContain('redirect("/traces")');
    expect(page).not.toContain("SUBPAGES");
  });

  it("Cost hub flattens predict modes (no nested Predict TabsList)", () => {
    const cost = src("app/(portal)/optimization/page.tsx");
    for (const tab of [
      "cost",
      "budget",
      "outcomes",
      "forecast",
      "drift",
      "spend",
      "capacity",
      "risk",
      "advisor",
    ]) {
      expect(cost).toContain(`value="${tab}"`);
    }
    expect(cost).not.toContain('value="predict"');
    const predict = src("app/(portal)/optimization/_components/predict-panels.tsx");
    expect(predict).toContain("PredictForecastPanel");
    expect(predict).not.toMatch(/TabsList[\s\S]*value="quality"/);
  });

  it("Signals entry is Alerts overflow only (no primary TabsTrigger)", () => {
    const alerts = src("app/(portal)/alerts/page.tsx");
    expect(alerts).toContain('setTab("signals")');
    expect(alerts).toContain("DropdownMenuItem");
    expect(alerts).not.toMatch(/TabsTrigger[^>]*value="signals"/);
    expect(collectSidebarHrefs()).not.toContain("/alerts?tab=signals");
  });
});

describe("W3 IA — ⌘K + docs", () => {
  it("command palette never hrefs retired dual homes", () => {
    const banned = new Set([
      "/observability",
      "/promotions",
      "/signals",
      "/users",
      "/insights",
      "/tools",
      "/optimization/predict",
    ]);
    for (const href of buildNavCommands().map((c) => c.href)) {
      if (isExternalHref(href) || href.startsWith("eden:")) continue;
      const path = href.split("?")[0];
      expect(banned.has(path), href).toBe(false);
    }
  });

  it("in-app docs sidebar + settings MCP point at quickstart only", () => {
    const docsItem = DEFAULT_SIDEBAR.flatMap((g) => g.items).find(
      (i) => i.id === "docs",
    );
    expect(docsItem?.href).toBe(DOCS_QUICKSTART_URL);
    const mcp = src("app/(portal)/settings/_components/mcp-tab.tsx");
    expect(mcp).toContain("DOCS_QUICKSTART_URL");
    expect(mcp).not.toContain("/how-to/mcp-cursor");
  });
});
