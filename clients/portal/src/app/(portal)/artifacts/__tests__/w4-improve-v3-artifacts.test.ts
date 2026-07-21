/**
 * Wave 4 — Improve V3 Artifacts + Ledger (+ promotions mode).
 * 4.1 modes without card walls; promote = hard boundary
 * 4.2 evidence gates visible before promote CTA
 * 4.3 Ledger modes; promotions nested; markdown calm
 * 4.4 Queue ↔ Artifacts ↔ Ledger loop strip (Prompts OK)
 * 4.5 Issue → Artifact → Promote ≤5 clicks
 * 4.6 marker data-wave4-improve-artifacts + critic
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveArtifactGate,
  type ArtifactDetail,
} from "@/components/artifacts/ArtifactDetailPanel";
import { ISSUE_ARTIFACT_PROMOTE_CLICK_PATH } from "@/components/artifacts/promote-click-path";
import { promotionsHref, artifactHref } from "@/lib/portal-cross-links";

const portalSrc = resolve(__dirname, "../../../../");

function read(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

function readArtifactsSurface(): string {
  return [
    read("app/(portal)/artifacts/page.tsx"),
    read("app/(portal)/artifacts/_components/artifacts-list.tsx"),
    read("app/(portal)/artifacts/_components/use-artifacts-page.ts"),
    read("app/(portal)/artifacts/_components/promote-override-dialog.tsx"),
  ].join("\n");
}

describe("Wave 4.1 — Artifacts modes + promote hard boundary", () => {
  it("uses underline mode tabs + row list (no card walls)", () => {
    const page = read("app/(portal)/artifacts/page.tsx");
    const list = read("app/(portal)/artifacts/_components/artifacts-list.tsx");
    expect(list).toContain('variant="underline"');
    expect(list).toContain('data-testid="artifacts-mode-tabs"');
    expect(list).toContain('data-testid="artifacts-mode-list"');
    expect(page).toContain('data-wave4-improve-artifacts="completed"');
    expect(readArtifactsSurface()).not.toContain('from "@/components/ui/card"');
    expect(readArtifactsSurface()).not.toContain("<CrossLinkBar");
  });

  it("keeps Promote off the list — detail boundary only", () => {
    const list = read("app/(portal)/artifacts/_components/artifacts-list.tsx");
    const panel = read("components/artifacts/ArtifactDetailPanel.tsx");
    // List rows export only; promote CTA lives in boundary.
    expect(list).not.toMatch(
      /artifactMode\(a\) === "shadow"[\s\S]{0,120}<Button[^>]*>[\s\S]{0,40}Promote/,
    );
    expect(panel).toContain('data-testid="artifact-promote-boundary"');
    expect(panel).toContain('data-testid="artifact-promote-cta"');
  });
});

describe("Wave 4.2 — Evidence gates before promote CTA", () => {
  it("derives collecting / review / ready and blocks under min_n", () => {
    expect(
      deriveArtifactGate({
        evidence: { n: 5, min_n: 30, passed: false },
      }).verdict,
    ).toBe("collecting");
    expect(
      deriveArtifactGate({
        evidence: { n: 5, min_n: 30, passed: false },
      }).blocked,
    ).toBe(true);
    expect(
      deriveArtifactGate({
        evidence: { n: 40, min_n: 30, passed: false },
      }).verdict,
    ).toBe("review");
    expect(
      deriveArtifactGate({
        evidence: { n: 40, min_n: 30, passed: true },
      }).verdict,
    ).toBe("ready");
    expect(
      deriveArtifactGate({
        cost: { value_score: 0.01 },
      }).lowValue,
    ).toBe(true);
  });

  it("renders evidence panel above Promote CTA in detail", () => {
    const panel = read("components/artifacts/ArtifactDetailPanel.tsx");
    const boundaryFn = panel.indexOf("function PromoteBoundary");
    const boundaryIdx = panel.indexOf('data-testid="artifact-promote-boundary"');
    const ctaIdx = panel.indexOf('data-testid="artifact-promote-cta"');
    expect(boundaryFn).toBeGreaterThan(-1);
    expect(boundaryIdx).toBeGreaterThan(boundaryFn);
    expect(ctaIdx).toBeGreaterThan(boundaryIdx);
    expect(panel).toContain("<EvidenceGatePanel");
    // Gates render inside PromoteBoundary before CTA (call site order).
    const callGates = panel.indexOf("<EvidenceGatePanel", boundaryFn);
    expect(callGates).toBeGreaterThan(boundaryFn);
    expect(callGates).toBeLessThan(ctaIdx);
    expect(panel).toContain("disabled={gate.blocked");
    expect(panel).not.toContain('from "@/components/ui/card"');
  });
});

describe("Wave 4.3 — Ledger modes + promotions nest + markdown calm", () => {
  it("nests promotions as Ledger mode with scent", () => {
    const ledger = read("app/(portal)/ledger/page.tsx");
    expect(ledger).toContain('data-wave4-improve-ledger="completed"');
    expect(ledger).toContain('data-testid="ledger-mode-promotions"');
    expect(ledger).toContain('value="promotions"');
    expect(ledger).toContain("EmbeddedSurface");
    expect(ledger).toContain("PromotionsView");
    expect(promotionsHref()).toBe("/ledger?tab=promotions");
  });

  it("promotions embed soft-redirects standalone + evidence before approve", () => {
    const promo = read("app/(portal)/promotions/page.tsx");
    expect(promo).toContain("useEmbeddedSurface");
    expect(promo).toContain("router.replace(promotionsHref())");
    expect(promo).toContain('data-testid="promotion-approve-boundary"');
    const gateIdx = promo.indexOf("EvidenceGateSummary");
    const ctaIdx = promo.indexOf('data-testid="promotion-approve-cta"');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(ctaIdx).toBeGreaterThan(gateIdx);
    // List no longer ships Approve wall — open for evidence.
    expect(promo).toContain("Open for evidence");
  });

  it("agent ledger markdown is calm (no Card walls)", () => {
    const book = read("app/(portal)/agents/[id]/ledger/page.tsx");
    expect(book).toContain("MarkdownProse");
    expect(book).toContain('data-testid="ledger-markdown-entries"');
    expect(book).not.toContain('from "@/components/ui/card"');
    expect(book).not.toContain("<CrossLinkBar");
    expect(book).toContain('from "@/components/ui/panel"');
  });
});

describe("Wave 4.4 — Loop strip Queue ↔ Artifacts ↔ Ledger", () => {
  it("scents Queue / Artifacts / Ledger / Prompts on hubs", () => {
    const artifacts = readArtifactsSurface();
    expect(artifacts).toContain('data-testid="artifacts-related-strip"');
    expect(artifacts).toMatch(/href="\/improve"[\s\S]{0,80}Queue/);
    expect(artifacts).toContain('href="/ledger"');
    expect(artifacts).toContain('href="/prompts"');

    const ledger = read("app/(portal)/ledger/page.tsx");
    expect(ledger).toContain('data-testid="ledger-related-strip"');
    expect(ledger).toMatch(/href="\/improve"[\s\S]{0,80}Queue/);
    expect(ledger).toContain("artifactHref()");
    expect(ledger).toContain('href="/prompts"');

    expect(artifactHref()).toBe("/artifacts");
    expect(artifactHref("a1")).toBe("/artifacts?artifactId=a1");
  });
});

describe("Wave 4.5 — Issue → Artifact → Promote ≤5 clicks", () => {
  it("preserves measured path at 4 clicks (≤5)", () => {
    expect(ISSUE_ARTIFACT_PROMOTE_CLICK_PATH.length).toBeLessThanOrEqual(5);
    expect(ISSUE_ARTIFACT_PROMOTE_CLICK_PATH).toEqual([
      "issues:open-issue",
      "issue:open-artifacts",
      "artifacts:select-row",
      "artifacts:promote-cta",
    ]);
    expect(read("components/artifacts/promote-click-path.ts")).toContain(
      "ISSUE_ARTIFACT_PROMOTE_CLICK_PATH",
    );

    const issueHeader = read("app/(portal)/issues/_components/issue-detail-header.tsx");
    expect(issueHeader).toContain('href="/artifacts"');
    expect(issueHeader).toContain("Open artifacts");

    const artifacts = readArtifactsSurface();
    expect(artifacts).toContain('data-testid="artifacts-select-row"');
    expect(artifacts).toContain("doPromote");
    expect(artifacts).toContain('toast.success("Artifact promoted")');
  });
});

describe("Wave 4.6 — critic + gate helper types", () => {
  it("ships critic and keeps ArtifactDetail type export", () => {
    const critic = resolve(portalSrc, "../.wave4-improve-critic.md");
    expect(existsSync(critic)).toBe(true);
    expect(readFileSync(critic, "utf8")).toMatch(/Wave 4/i);
    const sample: ArtifactDetail = { id: "1", mode: "shadow" };
    expect(sample.mode).toBe("shadow");
  });
});
