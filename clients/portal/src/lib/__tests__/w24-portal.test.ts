/**
 * Wave 24 — Autonomy loop + N21/N22 harden (portal contracts).
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readApiModules } from "./_read-api";

const ROOT = resolve(__dirname, "../../..");
const src = (rel: string) => readFileSync(resolve(ROOT, "src", rel), "utf8");
const py = (rel: string) =>
  readFileSync(resolve(ROOT, "../../src", rel), "utf8");
const docs = (rel: string) =>
  readFileSync(resolve(ROOT, "../../docs", rel), "utf8");

describe("W24 N22 Settings UX + API client", () => {
  it("exposes get/patch autonomy policy + audit on api", () => {
    const api = readApiModules(ROOT);
    expect(api).toContain("getAutonomyPolicy");
    expect(api).toContain("patchAutonomyPolicy");
    expect(api).toContain("getAutonomyAudit");
    expect(api).toContain("export type AutonomyPolicy");
    expect(api).toContain("maintenance_mode");
    expect(api).toContain("daily_maintenance_budget_usd");
  });

  it("Settings Autonomous tab edits N22 bounds", () => {
    const tab = src(
      "app/(portal)/settings/_components/autonomous-tab.tsx",
    );
    expect(tab).toContain("getAutonomyPolicy");
    expect(tab).toContain("patchAutonomyPolicy");
    expect(tab).toContain("Maintenance bounds (N22)");
    expect(tab).toContain("maintenance_mode");
    expect(tab).toContain("compliance_profile");
    expect(tab).toContain("auto_runtime_heal");
  });

  it("does not call retired Cat 23 intelligence/code-change routes", () => {
    const tab = src(
      "app/(portal)/settings/_components/autonomous-tab.tsx",
    );
    const api = readApiModules(ROOT);
    expect(tab).not.toContain("codeChangePolicyApi");
    expect(tab).not.toContain("disciplineApi");
    expect(api).not.toContain("codeChangePolicyApi");
    expect(api).not.toContain("disciplineApi");
    expect(api).not.toContain("/intelligence/code-change/");
    // Live heal / approve surfaces stay wired.
    expect(api).toContain("/intelligence/autonomous/heal");
    expect(tab).toContain("/heal");
  });
});

describe("W24 Improve cockpit heal + denials", () => {
  it("renders auto_heal and policy_denial badges", () => {
    const card = src("app/(portal)/improve/_components/queue-item-card.tsx");
    expect(card).toContain('item.item_type === "auto_heal"');
    expect(card).toContain('item.item_type === "policy_denial"');
    expect(card).toContain("Auto-heal event");
    expect(card).toContain("Policy denial");
  });

  it("cockpit aggregator sources self_heals + autonomy denials", () => {
    const agg = py("eden/improvement/cockpit_aggregator.py");
    expect(agg).toContain("_from_self_heals");
    expect(agg).toContain("_from_autonomy_denials");
    expect(agg).toContain('item_type="auto_heal"');
    expect(agg).toContain('item_type="policy_denial"');
  });
});

describe("W24 backend heal / policy / kill / spend", () => {
  it("heal_from_issue + kill switch + CostEvent autonomy tag exist", () => {
    const healer = py("eden/autonomous/investigation.py");
    expect(healer).toContain("async def heal_from_issue");
    expect(healer).toContain("is_autonomy_action_enabled");
    expect(healer).toContain("_execute_rollback");
    expect(healer).toContain("_execute_reweight");
    expect(healer).toContain("_execute_cache_bust");

    const kills = py("eden/llmops/feature_kills.py");
    expect(kills).toContain("is_autonomy_action_enabled");
    expect(kills).toContain('"rollback"');
    expect(kills).toContain("fail-closed");

    const cost = py("eden/llmops/cost_ledger.py");
    expect(cost).toContain('"autonomy"');

    const policy = py("eden/closed_loop/autonomy_policy.py");
    expect(policy).toContain("record_cost_event");
    expect(policy).toContain('feature=(feature or "autonomy")');
    expect(policy).toContain("CostEvent");
  });

  it("orchestrator gates heal with N22 + kill switch + learn on verify", () => {
    const orch = py("eden/closed_loop/orchestrator.py");
    expect(orch).toContain("is_autonomy_action_enabled");
    expect(orch).toContain("_flywheel_on_resolved");
    expect(orch).toContain("heal_from_issue");
    expect(orch).toContain("kill switch");
  });

  it("org create seeds autonomy_policies row", () => {
    const orgs = py("eden/api/routes/orgs.py");
    expect(orgs).toContain("autonomy_policies");
    expect(orgs).toContain("AutonomousMaintenancePolicy");
  });
});

describe("W24 runbook", () => {
  it("ships autonomy incident + rollback runbook", () => {
    const path = resolve(
      ROOT,
      "../../docs/runbooks/autonomy-incident-rollback.md",
    );
    expect(existsSync(path)).toBe(true);
    const rb = docs("runbooks/autonomy-incident-rollback.md");
    expect(rb).toContain("kill switch");
    expect(rb).toContain("N22");
    expect(rb).toContain("rollback");
  });
});
