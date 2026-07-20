import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CORE_NAV_ITEM_COUNT } from "@/lib/sidebar-config";
import { isKnownPortalPath, KNOWN_PORTAL_PREFIXES } from "@/lib/portal-routes";
import {
  buildNavCommands,
  collectSidebarHrefs,
  PALETTE_ACTIONS,
} from "@/lib/nav-commands";
import {
  MOBILE_CORE_NAV,
  MOBILE_MORE_LINKS,
} from "@/components/portal-os/MobileBottomNav";
import { isExternalHref } from "@/lib/utils";
import { HUB_REDIRECT_RULES } from "@/lib/portal-hub-redirect";

const ROOT = resolve(__dirname, "../../..");
const nextConfig = readFileSync(resolve(ROOT, "next.config.ts"), "utf8");

/** W3 UX-P0-13 GAP rules 8–13 — observability orphans → Traces facet/view. */
const OBSERVABILITY_GAP_REDIRECTS = [
  ["/observability/mcp", "/traces?facet=mcp"],
  ["/observability/decisions", "/traces?facet=decisions"],
  ["/observability/memory", "/traces?facet=memory"],
  ["/observability/retrieval", "/traces?facet=retrieval"],
  ["/observability/time-travel", "/traces?view=time-travel"],
  ["/observability/cohorts", "/traces?view=cohorts"],
] as const;

describe("U12 sidebar IA", () => {
  it("has at most 12 core nav items", () => {
    expect(CORE_NAV_ITEM_COUNT).toBeLessThanOrEqual(12);
  });
});

describe("portal-routes", () => {
  it("includes Phase 2 observe routes", () => {
    for (const prefix of ["/traces", "/sessions", "/artifacts", "/ledger"]) {
      expect(KNOWN_PORTAL_PREFIXES).toContain(prefix);
    }
  });

  it("recognizes session detail paths", () => {
    expect(isKnownPortalPath("/sessions/abc-123")).toBe(true);
    expect(isKnownPortalPath("/traces")).toBe(true);
  });
});

describe("U18 route agreement", () => {
  it("maps every sidebar href prefix to a known portal route", () => {
    const hrefs = collectSidebarHrefs().filter((h) => !isExternalHref(h));
    for (const href of hrefs) {
      expect(isKnownPortalPath(href)).toBe(true);
    }
  });

  it("includes core evaluate routes in portal-routes", () => {
    for (const prefix of ["/playgrounds", "/experiments", "/datasets", "/evals"]) {
      expect(KNOWN_PORTAL_PREFIXES).toContain(prefix);
    }
  });

  it("GAP observability children 308 to Traces facet/view (UX-P0-13 T6)", () => {
    for (const [source, destination] of OBSERVABILITY_GAP_REDIRECTS) {
      expect(nextConfig).toContain(`source: "${source}"`);
      expect(nextConfig).toContain(`destination: "${destination}"`);
      expect(nextConfig).toMatch(
        new RegExp(
          `source:\\s*"${source.replace(/\//g, "\\/")}"[^\\n]*destination:\\s*"${destination.replace(/[/?=]/g, "\\$&")}"[^\\n]*permanent:\\s*true`,
        ),
      );
    }
  });

  it("HUB_REDIRECT_RULES covers GAP observability soft nests", () => {
    for (const [source, destination] of OBSERVABILITY_GAP_REDIRECTS) {
      const rule = HUB_REDIRECT_RULES[source];
      expect(rule, source).toBeDefined();
      expect(rule.destination).toBe("/traces");
      const qs = new URLSearchParams(destination.split("?")[1]);
      const [key, value] = [...qs.entries()][0];
      expect(rule.defaultParams?.[key]).toBe(value);
    }
  });

  it("sidebar and ⌘K never href GAP observability from-paths", () => {
    const fromPaths = new Set(
      OBSERVABILITY_GAP_REDIRECTS.map(([source]) => source),
    );
    const hrefs = [
      ...collectSidebarHrefs(),
      ...buildNavCommands().map((c) => c.href),
      ...PALETTE_ACTIONS.map((c) => c.href),
    ];
    for (const href of hrefs) {
      if (isExternalHref(href) || href.startsWith("eden:")) continue;
      const path = href.split("?")[0].split("#")[0];
      expect(fromPaths.has(path), `nav href still points at redirect source: ${href}`).toBe(
        false,
      );
    }
  });
});

describe("U18 command palette", () => {
  it("exposes at least five quick actions", () => {
    expect(PALETTE_ACTIONS.length).toBeGreaterThanOrEqual(5);
  });

  it("includes actions in buildNavCommands output", () => {
    const cmds = buildNavCommands();
    const actions = cmds.filter((c) => c.kind === "action");
    expect(actions.length).toBeGreaterThanOrEqual(5);
  });
});

describe("U18 mobile shell", () => {
  it("locks bottom nav to four core items plus More sheet", () => {
    expect(MOBILE_CORE_NAV).toHaveLength(4);
    expect(MOBILE_CORE_NAV.map((i) => i.href)).toEqual([
      "/dashboard",
      "/traces",
      "/issues",
      "/improve",
    ]);
  });

  it("keeps Agents discoverable first in More (UX-P0-14) and uses text-2xs", () => {
    expect(MOBILE_MORE_LINKS[0]?.href).toBe("/agents");
    expect(MOBILE_MORE_LINKS[0]?.label).toBe("Agents");
    expect(MOBILE_MORE_LINKS.at(-1)?.href).toBe("/settings");
    const mobileSrc = readFileSync(
      resolve(ROOT, "src/components/portal-os/MobileBottomNav.tsx"),
      "utf8",
    );
    expect(mobileSrc).toContain("text-2xs");
    expect(mobileSrc).not.toContain("text-[10px]");
    expect(mobileSrc).toMatch(/Agents, artifacts/i);
    expect(mobileSrc).toContain("lg:hidden");
    expect(mobileSrc).not.toContain("md:hidden");
  });
});
