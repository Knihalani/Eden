/**
 * Wave 6 — Guardrails Improve V3: Policies primary; Promptfoo-style
 * red-team report drill; queue bridge; kit result surfaces.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portalSrc = resolve(__dirname, "../../../..");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

function lineCount(rel: string): number {
  return read(rel).split("\n").length;
}

describe("W6.1 hub IA — Policies primary; Red-team report mode", () => {
  it("defaults to Policies; Report is quiet More entry (not peer first-paint)", () => {
    const page = read("app/(portal)/guardrails/page.tsx");
    const types = read("app/(portal)/guardrails/_components/types.ts");
    expect(types).toContain('GUARDRAILS_PRIMARY_TABS = ["policies", "test"]');
    expect(page).toMatch(/useQueryTab\(\s*"tab",\s*GUARDRAILS_TABS,\s*"policies"/);
    expect(page).toContain('data-testid="guardrails-more-redteam"');
    expect(page).toContain("Red-team report");
    expect(page).toMatch(/activeTab === "redteam"[\s\S]*TabsTrigger[\s\S]*value="redteam"/);
    expect(page).toContain('data-wave6-improve-guardrails="completed"');
  });

  it("does not embed redteam/page.tsx (no nested PageHeader)", () => {
    const page = read("app/(portal)/guardrails/page.tsx");
    expect(page).toContain("RedteamReport");
    expect(page).not.toContain('import("@/app/(portal)/redteam/page")');
    expect(page).not.toContain("EmbeddedSurface");
  });
});

describe("W6.2 Promptfoo report drill", () => {
  it("ships summary → category → case → I/O surfaces", () => {
    const report = read(
      "app/(portal)/guardrails/_components/redteam-report.tsx",
    );
    expect(report).toContain('data-testid="guardrails-redteam-report"');
    expect(report).toContain('data-testid="redteam-report-summary"');
    expect(report).toContain('data-testid="redteam-report-categories"');
    expect(report).toContain('data-testid="redteam-report-cases"');
    expect(report).toContain('data-testid="redteam-report-io"');
    expect(report).toContain('data-testid="redteam-report-breadcrumb"');
    expect(report).toMatch(/DrillLevel|"summary".*"category".*"case"/);
    expect(report).toContain("Attack prompt");
    expect(report).toContain("Agent response");
    expect(report).toContain("failures first");
  });
});

describe("W6.3 queue bridge scent", () => {
  it("bridges failed guardrail / finding → improveHref", () => {
    const bridge = read(
      "app/(portal)/guardrails/_components/guardrails-queue-bridge.tsx",
    );
    const results = read(
      "app/(portal)/guardrails/_components/test-result-cards.tsx",
    );
    const report = read(
      "app/(portal)/guardrails/_components/redteam-report.tsx",
    );
    expect(bridge).toContain("improveHref");
    expect(bridge).toContain('testId = "guardrails-queue-bridge"');
    expect(bridge).toContain("data-testid={testId}");
    expect(bridge).toContain("Open Improve queue");
    expect(results).toContain("GuardrailsQueueBridge");
    expect(report).toContain("GuardrailsQueueBridge");
  });
});

describe("W6.4 declutter — kit primitives; no 3-card wall", () => {
  it("test mode shows one progressive result surface", () => {
    const test = read("app/(portal)/guardrails/_components/test-tab.tsx");
    expect(test).toContain('data-testid="guardrails-test-results"');
    expect(test).toContain("activeResultKind");
    expect(test).not.toContain("lg:grid-cols-3");
    expect(test).toContain('data-wave6-improve-test-results="ready"');
  });

  it("result cards use kit Panel + Badge (not hand-rolled card walls)", () => {
    const cards = read(
      "app/(portal)/guardrails/_components/test-result-cards.tsx",
    );
    expect(cards).toContain('from "@/components/ui/panel"');
    expect(cards).toContain('from "@/components/ui/badge"');
    expect(cards).toContain("SeverityBadge");
    expect(cards).not.toContain(
      "bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl",
    );
    expect(cards).not.toContain("rounded-full bg-[var(--error)]/20");
  });

  it("shell stays ≤400 LOC with report extracted", () => {
    expect(lineCount("app/(portal)/guardrails/page.tsx")).toBeLessThanOrEqual(
      400,
    );
    expect(
      existsSync(
        resolve(
          portalSrc,
          "app/(portal)/guardrails/_components/redteam-report.tsx",
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        resolve(
          portalSrc,
          "app/(portal)/guardrails/_components/guardrails-queue-bridge.tsx",
        ),
      ),
    ).toBe(true);
  });
});

describe("W6 redirect contract preserved", () => {
  it("keeps ?tab=redteam deep-link value", () => {
    const types = read("app/(portal)/guardrails/_components/types.ts");
    expect(types).toContain('"redteam"');
    expect(GUARDRAILS_TABS_INCLUDES_REDTEAM(types)).toBe(true);
  });
});

function GUARDRAILS_TABS_INCLUDES_REDTEAM(typesSrc: string): boolean {
  return /GUARDRAILS_TABS\s*=\s*\[[^\]]*redteam/.test(typesSrc);
}
