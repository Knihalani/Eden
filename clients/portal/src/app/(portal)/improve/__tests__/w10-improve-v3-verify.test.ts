/**
 * Improve V3 Wave 10 — a11y / perf / verify contracts.
 * Locks hub LOC, virtualization, axe route gates, dual headers, E2E loop, marker.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  IMPROVE_V3_AXE_ROUTES,
  IMPROVE_V3_SERIOUS_AXE_ROUTES,
  U20_SERIOUS_AXE_ROUTES,
} from "@/lib/portal-polish";
import { DEFAULT_SIDEBAR } from "@/lib/sidebar-config";
import { improveHref } from "@/lib/portal-cross-links";

const portalSrc = resolve(__dirname, "../../../../"); // …/clients/portal/src
const ROOT = resolve(portalSrc, ".."); // …/clients/portal

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

function lineCount(rel: string): number {
  return read(rel).split("\n").length;
}

/** Hand-rolled accent <button> count (kit Button ratchet). */
function rawAccentButtonCount(text: string): number {
  const lower = text.toLowerCase();
  let total = 0;
  let i = 0;
  while (i < text.length) {
    const start = lower.indexOf("<button", i);
    if (start < 0) break;
    const after = start + 7;
    if (text[after] && /[a-zA-Z0-9]/.test(text[after])) {
      i = after;
      continue;
    }
    let j = after;
    let quote: string | null = null;
    while (j < text.length && j - start < 4000) {
      const c = text[j];
      if (quote) {
        if (c === quote && text[j - 1] !== "\\") quote = null;
      } else if (c === '"' || c === "'" || c === "`") {
        quote = c;
      } else if (c === ">") {
        break;
      }
      j += 1;
    }
    const tag = text.slice(start, j + 1);
    if (/bg-\[var\(--accent\)\]/.test(tag)) total += 1;
    i = j + 1;
  }
  return total;
}

const IMPROVE_SHELLS = [
  "app/(portal)/improve/page.tsx",
  "app/(portal)/improve/plans/[id]/page.tsx",
  "app/(portal)/artifacts/page.tsx",
  "app/(portal)/ledger/page.tsx",
  "app/(portal)/prompts/page.tsx",
  "app/(portal)/guardrails/page.tsx",
  "app/(portal)/optimization/page.tsx",
] as const;

/** Shells intentionally above ≤400 — listed in .wave10-improve-verifier.md. */
const INTENTIONAL_LOC_DEBT = new Set<string>([]);

describe("W10 Improve V3 — marker + hub", () => {
  it("hub marks data-wave10-improve-verify completed", () => {
    const page = read("app/(portal)/improve/page.tsx");
    expect(page).toContain('data-wave10-improve-verify="completed"');
    expect(lineCount("app/(portal)/improve/page.tsx")).toBeLessThanOrEqual(400);
  });
});

describe("W10 Improve V3 — virtualization", () => {
  it("queue board keeps VirtualizedList (no peel regression)", () => {
    const board = read("app/(portal)/improve/_components/queue-board.tsx");
    expect(board).toContain("VirtualizedList");
    expect(board).toContain("@/components/portal-os");
  });
});

describe("W10 Improve V3 — LOC sweep", () => {
  it("core shells ≤400 (no intentional LOC debt)", () => {
    for (const rel of IMPROVE_SHELLS) {
      const loc = lineCount(rel);
      if (INTENTIONAL_LOC_DEBT.has(rel)) {
        expect(loc, rel).toBeGreaterThan(400);
        continue;
      }
      expect(loc, `${rel} should be ≤400`).toBeLessThanOrEqual(400);
    }
  });

  it("verifier doc records plans/[id] + artifacts peels ≤400", () => {
    const doc = readFileSync(resolve(ROOT, ".wave10-improve-verifier.md"), "utf8");
    expect(doc).toMatch(/plans\/\[id\].*268|268.*plans\/\[id\]/);
    expect(doc).toContain("plans/[id]");
    expect(doc).toMatch(/artifacts\/page\.tsx.*\*\*131\*\*|\*\*131\*\*.*artifacts/);
  });
});

describe("W10 Improve V3 — axe gates", () => {
  it("IMPROVE_V3 serious routes cover Wave 10 target set", () => {
    expect([...IMPROVE_V3_AXE_ROUTES]).toEqual([
      "/improve",
      "/artifacts",
      "/ledger",
      "/prompts",
      "/guardrails",
      "/optimization",
    ]);
    expect([...IMPROVE_V3_SERIOUS_AXE_ROUTES]).toEqual([...IMPROVE_V3_AXE_ROUTES]);
    // Historical U20 gate still includes /improve
    expect([...U20_SERIOUS_AXE_ROUTES]).toContain("/improve");
  });

  it("audit-a11y.cjs serious-gates Improve V3 routes", () => {
    const script = readFileSync(resolve(ROOT, "scripts/audit-a11y.cjs"), "utf8");
    for (const route of IMPROVE_V3_SERIOUS_AXE_ROUTES) {
      expect(script).toContain(`"${route}"`);
    }
    expect(script).toContain("SERIOUS_GATE_ROUTES");
  });

  it("on-disk auth reports serious=0 for available Improve-group captures", () => {
    const available = [
      ["report-a11y-auth-%2Fimprove.json", "/improve"],
      ["report-a11y-auth-%2Fartifacts.json", "/artifacts"],
    ] as const;
    for (const [file, route] of available) {
      const path = resolve(ROOT, file);
      expect(existsSync(path), `${route} report missing`).toBe(true);
      const report = JSON.parse(readFileSync(path, "utf8")) as {
        violations?: { impact?: string }[];
      };
      const serious = (report.violations ?? []).filter((v) => v.impact === "serious");
      const critical = (report.violations ?? []).filter((v) => v.impact === "critical");
      expect(critical, route).toHaveLength(0);
      expect(serious, route).toHaveLength(0);
    }
  });
});

describe("W10 Improve V3 — success metrics contracts", () => {
  it("core Improve nav: Queue, Artifacts, Ledger, Prompts", () => {
    const improve = DEFAULT_SIDEBAR.find((g) => g.id === "improve")!;
    const core = improve.items.filter((i) => i.category !== "advanced");
    expect(core.map((i) => i.id)).toEqual([
      "improve",
      "artifacts",
      "ledger",
      "prompts",
    ]);
  });

  it("embedded Plans/History hide PageHeader via EmbeddedSurface", () => {
    const page = read("app/(portal)/improve/page.tsx");
    expect(page).toContain("EmbeddedSurface");
    const header = read("components/layout/page-header.tsx");
    expect(header).toContain("useEmbeddedSurface");
  });

  it("Issue → Improve act path ≤3 clicks (open issue → Open Improve → act)", () => {
    expect(improveHref("issue-1")).toContain("/improve");
    const detail = read("app/(portal)/issues/_components/issues-detail-panel.tsx");
    expect(detail).toContain("improveHref");
    expect(detail).toContain("Open Improve");
    const panel = read("app/(portal)/improve/_components/queue-detail-panel.tsx");
    expect(panel).toContain("primaryActionForItem");
    expect(panel).toContain('data-testid="improve-queue-primary-cta"');
  });

  it("Issue → Artifact → Promote path ≤5 clicks still wired", () => {
    const header = read("app/(portal)/issues/_components/issue-detail-header.tsx");
    expect(header).toContain('href="/artifacts"');
    expect(header).toContain("Open artifacts");
    const artifacts = read("app/(portal)/artifacts/_components/use-artifacts-page.ts");
    expect(artifacts).toContain("doPromote");
  });

  it("hand-rolled accent CTA ratchet: hub + queue peel = 0 raw accent buttons", () => {
    for (const rel of [
      "app/(portal)/improve/page.tsx",
      "app/(portal)/improve/_components/queue-board.tsx",
      "app/(portal)/improve/_components/queue-detail-panel.tsx",
      "app/(portal)/improve/_components/queue-item-card.tsx",
    ]) {
      expect(rawAccentButtonCount(read(rel)), rel).toBe(0);
    }
  });
});

describe("W10 Improve V3 — E2E + verifier artifacts", () => {
  it("ships w10-improve-v3-loop.mjs dry-run contract", () => {
    const sketch = readFileSync(
      resolve(ROOT, "e2e/golden/w10-improve-v3-loop.mjs"),
      "utf8",
    );
    expect(sketch).toContain("W10_IMPROVE_V3_LOOP");
    expect(sketch).toContain("/improve");
    expect(sketch).toContain("/artifacts");
    expect(sketch).toContain("/ledger");
    expect(sketch).toContain("/prompts");
    expect(sketch).toContain("data-wave10-improve-verify");
  });

  it("w12 loop documents optional Prompts hop", () => {
    const sketch = readFileSync(
      resolve(ROOT, "e2e/golden/w12-observe-eval-improve.mjs"),
      "utf8",
    );
    expect(sketch).toContain("W12_IMPROVE_V3_PROMPTS_HOP");
    expect(sketch).toContain("w10-improve-v3-loop.mjs");
  });

  it("writes .wave10-improve-verifier.md", () => {
    expect(existsSync(resolve(ROOT, ".wave10-improve-verifier.md"))).toBe(true);
  });
});
