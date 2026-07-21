/**
 * Improve V3 Wave 11 — Freeze / signoff contracts.
 * Markers (W1–W10), hub LOC ≤400, sidebar Prompts core, related-strip IA,
 * CHANGELOG/DESIGN/route-matrix/baselines/critic artifacts.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SIDEBAR } from "@/lib/sidebar-config";
import {
  RELATED_LINKS,
  WAVE1_IMPROVE_IA_COMPLETED,
  WAVE2_IMPROVE_QUEUE_COMPLETED,
  WAVE3_IMPROVE_PLANS_COMPLETED,
  WAVE9_IMPROVE_CROSSLOOP_COMPLETED,
} from "@/app/(portal)/improve/_components";
import {
  IMPROVE_V3_AXE_ROUTES,
  IMPROVE_V3_SERIOUS_AXE_ROUTES,
} from "@/lib/portal-polish";

const ROOT = resolve(__dirname, "../../../..");
const src = (rel: string) => readFileSync(resolve(ROOT, "src", rel), "utf8");
const rootFile = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

const HUB_MARKERS = [
  'data-wave1-improve="completed"',
  'data-wave2-improve-queue="completed"',
  'data-wave7-improve="completed"',
  'data-wave8-improve="completed"',
  'data-wave9-improve-crossloop="completed"',
  'data-wave10-improve-verify="completed"',
] as const;

const IMPROVE_V3_BASELINE_IDS = [
  "improve-queue-v3",
  "04-artifacts",
  "improve-ledger-v3",
  "improve-prompts-v3",
  "improve-guardrails-v3",
  "improve-cost-v3",
  "improve-plans-detail-v3",
] as const;

describe("W11 Improve V3 freeze — wave markers", () => {
  it("locks hub toolbar markers for waves 1–2 and 7–10", () => {
    const hub = src("app/(portal)/improve/page.tsx");
    for (const marker of HUB_MARKERS) {
      expect(hub).toContain(marker);
    }
  });

  it("locks satellite completed markers (W3–W6, W8 advanced)", () => {
    expect(src("app/(portal)/improve/plans/page.tsx")).toContain(
      'data-wave3-improve-plans="completed"',
    );
    expect(src("app/(portal)/improve/plans/[id]/page.tsx")).toContain(
      'data-wave3-improve-plans="completed"',
    );
    expect(src("app/(portal)/artifacts/page.tsx")).toContain(
      'data-wave4-improve-artifacts="completed"',
    );
    expect(src("app/(portal)/ledger/page.tsx")).toContain(
      'data-wave4-improve-ledger="completed"',
    );
    expect(src("app/(portal)/prompts/page.tsx")).toContain(
      'data-wave5-improve-prompts="completed"',
    );
    expect(src("app/(portal)/guardrails/page.tsx")).toContain(
      'data-wave6-improve-guardrails="completed"',
    );
    expect(src("app/(portal)/optimization/page.tsx")).toMatch(
      /data-wave7-improve-cost=/,
    );
    for (const leaf of [
      "app/(portal)/improve/scorecard/page.tsx",
      "app/(portal)/improve/online-scoring/page.tsx",
      "app/(portal)/improve/change-impact/page.tsx",
    ]) {
      expect(src(leaf)).toContain('data-wave8-improve-advanced="completed"');
    }
  });

  it("keeps wave completion constants true", () => {
    expect(WAVE1_IMPROVE_IA_COMPLETED).toBe(true);
    expect(WAVE2_IMPROVE_QUEUE_COMPLETED).toBe(true);
    expect(WAVE3_IMPROVE_PLANS_COMPLETED).toBe(true);
    expect(WAVE9_IMPROVE_CROSSLOOP_COMPLETED).toBe(true);
  });
});

describe("W11 Improve V3 freeze — hub LOC + peel", () => {
  it("improve hub shell ≤400 LOC", () => {
    const lines = src("app/(portal)/improve/page.tsx").split("\n").length;
    expect(lines).toBeLessThanOrEqual(400);
    expect(lines).toBeLessThanOrEqual(200);
  });

  it("plans detail + artifacts shells ≤400 LOC after peel", () => {
    expect(
      src("app/(portal)/improve/plans/[id]/page.tsx").split("\n").length,
    ).toBeLessThanOrEqual(400);
    expect(
      src("app/(portal)/artifacts/page.tsx").split("\n").length,
    ).toBeLessThanOrEqual(400);
  });

  it("queue peel lives under improve/_components", () => {
    expect(
      existsSync(
        resolve(ROOT, "src/app/(portal)/improve/_components/queue-board.tsx"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        resolve(
          ROOT,
          "src/app/(portal)/improve/_components/improve-related-strip.tsx",
        ),
      ),
    ).toBe(true);
  });
});

describe("W11 Improve V3 freeze — sidebar Prompts core", () => {
  it("Prompts is core Improve; Advanced list excludes Prompts", () => {
    const group = DEFAULT_SIDEBAR.find((g) => g.id === "improve")!;
    const core = group.items.filter((i) => i.category !== "advanced");
    expect(core.map((i) => i.id)).toEqual([
      "improve",
      "artifacts",
      "ledger",
      "prompts",
    ]);
    const prompts = group.items.find((i) => i.id === "prompts")!;
    expect(prompts.category).toBeUndefined();
    const advanced = group.items.filter((i) => i.category === "advanced");
    expect(advanced.map((i) => i.id)).toEqual([
      "scorecard",
      "online-scoring",
      "change-impact",
      "guardrails",
      "optimization",
    ]);
    expect(advanced.some((i) => i.id === "prompts")).toBe(false);
  });
});

describe("W11 Improve V3 freeze — related-strip IA", () => {
  it("related strip is Issues · Artifacts · Ledger · Prompts only", () => {
    expect(RELATED_LINKS.map((l) => l.label)).toEqual([
      "Issues",
      "Artifacts",
      "Ledger",
      "Prompts",
    ]);
    expect(RELATED_LINKS.map((l) => l.href)).toEqual([
      "/issues",
      "/artifacts",
      "/ledger",
      "/prompts",
    ]);
    const strip = src(
      "app/(portal)/improve/_components/improve-related-strip.tsx",
    );
    expect(strip).toContain('data-testid="improve-related-strip"');
    expect(strip).not.toMatch(/scorecard|guardrails|optimization|online-scoring/);
  });
});

describe("W11 Improve V3 freeze — Evaluate stays separate", () => {
  it("does not merge /evals into Improve sidebar", () => {
    const group = DEFAULT_SIDEBAR.find((g) => g.id === "improve")!;
    expect(group.items.some((i) => i.href.startsWith("/evals"))).toBe(false);
    expect(group.items.some((i) => i.id === "evals")).toBe(false);
  });
});

describe("W11 Improve V3 freeze — axe route lock", () => {
  it("keeps Improve-group serious axe routes", () => {
    expect([...IMPROVE_V3_AXE_ROUTES]).toEqual([
      "/improve",
      "/artifacts",
      "/ledger",
      "/prompts",
      "/guardrails",
      "/optimization",
    ]);
    expect([...IMPROVE_V3_SERIOUS_AXE_ROUTES]).toEqual([
      ...IMPROVE_V3_AXE_ROUTES,
    ]);
  });
});

describe("W11 Improve V3 freeze — docs + baselines + critic", () => {
  it("ships CHANGELOG Improve V3 + DESIGN §11b IA paragraph", () => {
    const changelog = rootFile("CHANGELOG-UX.md");
    expect(changelog).toContain("Improve V3");
    expect(changelog).toMatch(/Prompts.*core|Prompts→core/i);
    expect(changelog).toMatch(/Evaluate stays separate|not.*merged/i);

    const design = rootFile("DESIGN.md");
    expect(design).toContain("Improve interaction contract (V3)");
    expect(design).toContain("IMPROVE_V3_PLAN.md");
    expect(design).toMatch(/Prompts.*promoted to core|Prompts.*core/i);
    expect(design).toMatch(/Evaluate.*stays separate|compare/i);
    expect(design).toMatch(/no new accents/i);
  });

  it("re-signs Improve rows in route matrix", () => {
    const matrix = rootFile(".wave12-route-matrix.md");
    expect(matrix).toContain("Improve V3");
    expect(matrix).toContain("IV3");
    expect(matrix).toContain("`/improve`");
    expect(matrix).toContain("`/prompts`");
    expect(matrix).toMatch(/140/);
    expect(matrix).toMatch(/Evaluate separate|Evaluate stays separate/i);
  });

  it("documents Improve V3 visual baseline ids", () => {
    const baselines = rootFile("e2e/golden/w12-visual-baselines.md");
    expect(baselines).toContain("Improve V3");
    for (const id of IMPROVE_V3_BASELINE_IDS) {
      expect(baselines).toContain(id);
    }
    const artifactsPng = resolve(
      ROOT,
      "e2e/golden/screenshots/04-artifacts.png",
    );
    const artifactsFail = resolve(
      ROOT,
      "e2e/golden/screenshots/04-artifacts-fail.png",
    );
    expect(existsSync(artifactsPng) || existsSync(artifactsFail)).toBe(true);
  });

  it("ships final critic with SHIP verdict + peel clearance", () => {
    const criticPath = resolve(ROOT, ".wave11-improve-final-critic.md");
    expect(existsSync(criticPath)).toBe(true);
    const critic = readFileSync(criticPath, "utf8");
    expect(critic).toMatch(/\bSHIP\b/);
    expect(critic).not.toMatch(/\bno-SHIP\b/i);
    expect(critic).toMatch(/268/);
    expect(critic).toMatch(/131/);
    expect(critic).toMatch(/Cleared post-freeze/);
    expect(critic).toMatch(/build|re-axe|audit:a11y/i);
    expect(critic).toMatch(/PASS/);
    expect(critic).toContain("IMPROVE_V3_PLAN.md");
  });

  it("keeps W10 verifier artifact", () => {
    expect(existsSync(resolve(ROOT, ".wave10-improve-verifier.md"))).toBe(
      true,
    );
  });
});
