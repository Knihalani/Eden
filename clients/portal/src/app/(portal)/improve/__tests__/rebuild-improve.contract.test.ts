/**
 * Phase 5 Improve contract — surfaces/improve.md acceptance (hub chrome / IA).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getCoreNavLeaves } from "@/lib/sidebar-config";
import {
  IMPROVE_TABS,
  parseImproveSearchParams,
  writeImproveSearchParams,
} from "@/lib/improve-url";

const portalSrc = path.resolve(__dirname, "../../../..");
const improveRoot = path.join(portalSrc, "app/(portal)/improve");
const improveComponents = path.join(portalSrc, "components/improve");
const nextConfig = path.join(portalSrc, "../next.config.ts");
const enMessages = path.join(portalSrc, "messages/en.json");
const deMessages = path.join(portalSrc, "messages/de.json");
const agentLedger = path.join(
  portalSrc,
  "app/(portal)/agents/[id]/ledger/page.tsx",
);

function walkTs(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__") continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkTs(full, acc);
    else if (/\.(tsx|ts)$/.test(name)) acc.push(full);
  }
  return acc;
}

describe("rebuild improve contract", () => {
  it("required hub routes and shared domain components exist", () => {
    expect(existsSync(path.join(improveRoot, "page.tsx"))).toBe(true);
    expect(existsSync(path.join(improveRoot, "loading.tsx"))).toBe(true);
    expect(
      existsSync(path.join(improveRoot, "plans/[id]/page.tsx")),
    ).toBe(true);
    expect(
      existsSync(path.join(improveRoot, "_hooks/use-improve-url-state.ts")),
    ).toBe(true);
    expect(
      existsSync(path.join(improveRoot, "_components/improve-hub-toolbar.tsx")),
    ).toBe(true);

    for (const name of [
      "evidence-gate-banner via evidence-strip",
      "ledger-timeline.tsx",
      "outcome-triad.tsx",
      "rca-panel.tsx",
      "show-code-panel.tsx",
      "artifact-version-table.tsx",
      "related-strip.tsx",
      "pr-outcome-card.tsx",
      "ledger-entry-detail.tsx",
    ]) {
      if (name.includes("via")) {
        expect(existsSync(path.join(improveComponents, "evidence-strip.tsx"))).toBe(
          true,
        );
        continue;
      }
      expect(existsSync(path.join(improveComponents, name))).toBe(true);
    }
  });

  it("hub tabs + keyboard + related strip + no EmbeddedSurface", () => {
    const page = readFileSync(path.join(improveRoot, "page.tsx"), "utf8");
    for (const tab of IMPROVE_TABS) {
      expect(page).toContain(tab);
    }
    expect(page).toContain("clearSelection");
    expect(page).toContain("IMPROVE_TABS");
    expect(page).toContain("/issues");
    expect(page).toContain("/traces");
    expect(page).toContain("/cost");
    expect(page).not.toContain("EmbeddedSurface");
    expect(page).not.toContain("useEmbeddedSurface");

    for (const f of walkTs(improveRoot)) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toContain("EmbeddedSurface");
      expect(src).not.toContain("useEmbeddedSurface");
      expect(src).not.toMatch(/red-?team/i);
    }
  });

  it("plan detail exposes Evidence RCA Code Artifacts PR Activity panels", () => {
    const page = readFileSync(
      path.join(improveRoot, "plans/[id]/page.tsx"),
      "utf8",
    );
    expect(page).toContain("evidence");
    expect(page).toContain("rca");
    expect(page).toContain("code");
    expect(page).toContain("artifacts");
    expect(page).toContain("pr");
    expect(page).toContain("activity");
    expect(page).toContain("OutcomeTriad");
    expect(page).toContain("EvidenceGateBanner");
  });

  it("sidebar improve href is live /improve", () => {
    const improve = getCoreNavLeaves().find((i) => i.id === "improve");
    expect(improve?.href).toBe("/improve");
  });

  it("softLand excludes improve family; redirects source legacy leaves", () => {
    const cfg = readFileSync(nextConfig, "utf8");
    const softLandBody = cfg.match(/softLand\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
    expect(softLandBody).not.toMatch(/"\/improve"/);
    expect(softLandBody).not.toMatch(/"\/artifacts"/);
    expect(softLandBody).not.toMatch(/"\/ledger"/);
    expect(softLandBody).not.toMatch(/"\/promotions"/);

    expect(cfg).toMatch(/source: ["']\/artifacts["']/);
    expect(cfg).toMatch(/destination: ["']\/improve\?tab=artifacts["']/);
    expect(cfg).toMatch(/source: ["']\/ledger["']/);
    expect(cfg).toMatch(/destination: ["']\/improve\?tab=ledger["']/);
    expect(cfg).toMatch(/source: ["']\/promotions["']/);
    expect(cfg).toMatch(/destination: ["']\/improve\?tab=promotions["']/);
  });

  it("agent ledger reuses shared LedgerTimeline via LedgerTab", () => {
    const src = readFileSync(agentLedger, "utf8");
    expect(src).toContain("LedgerTab");
    expect(src).toContain("lockedAgentId");
    expect(src).not.toContain("EmbeddedSurface");
  });

  it("improve-url grammar defaults and entryId selection", () => {
    const parsed = parseImproveSearchParams(new URLSearchParams());
    expect(parsed.tab).toBe("queue");
    const withEntry = writeImproveSearchParams({
      tab: "ledger",
      entryId: "led_1",
    });
    expect(withEntry.get("tab")).toBe("ledger");
    expect(withEntry.get("entryId")).toBe("led_1");
  });

  it("i18n improve namespace present in en and de", () => {
    const en = JSON.parse(readFileSync(enMessages, "utf8")) as {
      improve?: { title?: string; tabs?: { queue?: string; ledger?: string } };
      cost?: unknown;
      guardrails?: unknown;
    };
    const de = JSON.parse(readFileSync(deMessages, "utf8")) as {
      improve?: { title?: string; tabs?: { queue?: string; ledger?: string } };
    };
    expect(en.improve?.title).toBeTruthy();
    expect(de.improve?.title).toBeTruthy();
    expect(en.improve?.tabs?.queue).toBeTruthy();
    expect(en.improve?.tabs?.ledger).toBeTruthy();
    expect(de.improve?.tabs?.queue).toBeTruthy();
  });
});
