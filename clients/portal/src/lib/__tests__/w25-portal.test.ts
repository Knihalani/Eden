/**
 * Wave 25 — Evolution + promote flywheel (portal contracts).
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const src = (rel: string) => readFileSync(resolve(ROOT, "src", rel), "utf8");
const py = (rel: string) =>
  readFileSync(resolve(ROOT, "../../src", rel), "utf8");
const docs = (rel: string) =>
  readFileSync(resolve(ROOT, "../../docs", rel), "utf8");

describe("W25 Promotions EvidenceGate honesty", () => {
  it("shows min_n hold + Bayesian advisory fields", () => {
    const page = src("app/(portal)/promotions/page.tsx");
    expect(page).toContain("EvidenceGateSummary");
    expect(page).toContain("min-n-hold");
    expect(page).toContain("bayesian_respects_min_n");
    expect(page).toContain("Promote blocked under min_n");
    expect(page).toContain("Min samples (honest floor)");
  });
});

describe("W25 FinOps evolution/promote spend", () => {
  it("surfaces feature=evolution and feature=promote tiles", () => {
    const explorer = src(
      "app/(portal)/optimization/_components/finops-explorer.tsx",
    );
    expect(explorer).toContain("evolve-promote-spend");
    // Labels use plain "Evolution" / "Promote" text (not query-string anchors)
    expect(explorer).toContain(">Evolution<");
    expect(explorer).toContain(">Promote<");
    expect(explorer).toContain("evolution_usd");
    expect(explorer).toContain("promote_usd");
  });
});

describe("W25 backend EvidenceGate non-optional", () => {
  it("gates prompt canary promote via EvidenceGate", () => {
    const route = py("eden/api/routes/prompt_canary.py");
    expect(route).toContain("EvidenceGate");
    expect(route).toContain("evaluate");
    expect(route).toContain("EvidenceGate is non-optional");
  });

  it("PromotionLoop requires EvidenceGate for promote", () => {
    const loop = py("eden/llmops/promotion.py");
    expect(loop).toContain("_evidence_gate_promote");
    expect(loop).toContain("EvidenceGate is non-optional");
  });

  it("Bayesian path respects min_n", () => {
    const gate = py("eden/promotion/evidence_gate.py");
    expect(gate).toContain("bayesian_respects_min_n");
    expect(gate).toContain("bayesian_advisory_only");
    expect(gate).toContain("_activate_live_guardrail");
    expect(gate).toContain("_ledger_dnr");
    expect(gate).toContain('feature="promote"');
  });

  it("degrade-on-judge rolls back canaries", () => {
    const hooks = py("eden/llmops/promotion_hooks.py");
    expect(hooks).toContain("_degrade_active_canaries");
    expect(hooks).toContain("degrade-on-judge");
  });

  it("CostEvent knows evolution + promote features", () => {
    const cost = py("eden/llmops/cost_ledger.py");
    expect(cost).toContain('"evolution"');
    expect(cost).toContain('"promote"');
  });

  it("evolution spend writes evolution_ops_spend only", () => {
    const spend = py("eden/llmops/evolution_spend.py");
    expect(spend).toContain("evolution_ops_spend");
    expect(spend).toContain("INSERT INTO evolution_ops_spend");
    expect(spend).toContain("no customer CostEvent");
    expect(spend).not.toContain("record_cost_event");
    expect(spend).not.toContain('feature="evolution"');
  });
});

describe("W25 staging flywheel runbook", () => {
  it("documents artifact draft→promote→gateway inject", () => {
    const path = resolve(
      ROOT,
      "../../docs/runbooks/evolve-promote-flywheel.md",
    );
    expect(existsSync(path)).toBe(true);
    const rb = docs("runbooks/evolve-promote-flywheel.md");
    expect(rb).toContain("EvidenceGate");
    expect(rb).toContain("Draft");
    expect(rb).toContain("promote");
    expect(rb).toContain("gateway");
    expect(rb).toContain("min_n");
  });
});
