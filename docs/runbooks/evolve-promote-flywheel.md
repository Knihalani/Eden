# Evolve + promote flywheel (W25)

Staging / dogfood path proving EvidenceGate is non-optional for
artifact and guardrail promotion into the live gateway.

## Flow

```
1. Draft shadow Artifact (nudge)
   POST /orgs/{org}/nudges  → mode=shadow + EvidenceGate enqueue

2. Collect outcomes until min_n (nudge=50 / guardrail=100)
   — promote under min_n returns recommendation=hold

3. Promote via EvidenceGate only
   POST /orgs/{org}/promotions/{id}/approve
   OR POST /orgs/{org}/nudges/{id}/promote
   — both call EvidenceGate.promote_if_passed
   — direct mode=promoted without the gate is not supported

4. Gateway inject (warm cache proof)
   EvidenceGate promote → warm_learn_caches → NudgeGatewayFilter
   install_learn_filters wires runtime_nudge on /gateway/v1

5. 7d demotion → Ledger DNR
   ArtifactDemotionWorker demotes + LedgerGenerator.upsert_do_not_repeat
```

## N15 guardrail path

```
POST /orgs/{org}/eval/promote-to-shadow-guardrail
  → policy + EvidenceGate enqueue (enforcement=log)
POST /orgs/{org}/promotions/{id}/approve  (after min_n)
  → enforcement_level=block on JudgeGuardrailFilter
```

## N18 evolution

- Spend gate: `EvolutionSpendBudget` + CostEvent `feature=evolution`
- Canary %: org `evolver_auto_canary_pct` (default 5)
- Cockpit: Improve shows `prompt_canary` cards
- Degrade-on-judge: `PromotionHook.on_judge_regression` rolls back active canaries

## FinOps

Explorer tiles: **Evolution spend** (`feature=evolution`) and
**Promote spend** (`feature=promote`).

## Verify locally

```bash
python -m pytest tests/unit/promotion/test_w25_evolve_promote.py --noconftest -q
cd clients/portal && bun test src/lib/__tests__/w25-portal.test.ts
```

## Kill switches

| Flag / kill | Effect |
|-------------|--------|
| `evolution_loop_enabled` | Stops N18 loop |
| FinOps kill `evolution` | Skips JudgeScorePromptEvolver |
| FinOps kill `promote` | Operators can pause promote-tagged spend visibility / future gates |
| `artifacts_v1=false` | No shadow Artifact create (org kill or Settings) |
