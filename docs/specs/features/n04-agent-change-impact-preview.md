# N04: Agent Change Impact Preview

| Field | Value |
|---|---|
| **Feature ID** | N04 |
| **Slug** | `agent-change-impact-preview` |
| **Priority** | P1 |
| **Effort** | L |
| **Eden status** | **MISSING** |
| **Market hypothesis** | "What breaks if I ship this prompt?" — top pre-deploy anxiety for agent teams |
| **Dependencies** | F01 (cached rerun), N01 (regression evals), F44, Cat 20 time-travel |

---

## 1. Problem

Agent changes (prompt, tool schema, model swap) lack **preview against real production behavior**. Traditional unit tests miss multi-step agent trajectories. Laminar debugger + Raindrop experiments address slices of this; Eden has pieces (debugger, experiments, evals) but no unified **Change Impact Report**.

---

## 2. Target behavior

```
Engineer opens PR changing prompts/checkout.yaml
    → Eden webhook detects agent config change
    → Impact Preview job:
        1. Select N production traces (stratified: recent, high-cost, past issues)
        2. Cached-prefix rerun (F01) with new config on each
        3. Run regression eval suite (N01)
        4. Diff trajectories + cost + stumble predictions
    → Post PR comment + MCP resource with report
    → Block merge if regression eval fails (optional branch protection)
```

---

## 3. Impact report schema

```json
{
  "change_id": "pr-4821",
  "agent_id": "checkout-agent",
  "traces_replayed": 50,
  "trajectory_divergence_rate": 0.12,
  "new_predicted_stumbles": 3,
  "cost_delta_pct": -0.08,
  "regression_eval": {"passed": 47, "failed": 3, "failures": [...]},
  "recommendation": "review_required",
  "top_divergences": [{"trace_id": "...", "step": 8, "summary": "..."}]
}
```

---

## 4. Architecture

| Component | Path |
|---|---|
| `ChangeDetector` | GitHub webhook on `prompts/**`, `agent.yaml` |
| `ImpactPreviewOrchestrator` | `src/eden/change_impact/preview.py` |
| `TraceSampler` | Stratified sample from production (7d window) |
| `TrajectoryDiffer` | Step-level diff (reuse debugger diff from F01) |
| `PRCommenter` | GitHub Check Run + markdown summary |

**Cost control:** Max 50 replays/PR default; cached prefix keeps cost ~tail steps only.

---

## 5. MCP integration (F04)

| Tool | Purpose |
|---|---|
| `preview_change_impact` | Manual trigger with config diff |
| `get_impact_report` | Fetch report for PR/change_id |

---

## 6. Eden moat

Combines **unique** Eden capabilities competitors lack in one flow:
- Cached-prefix rerun (F01) — cheap production replay
- StatGate trajectory quality (not just LLM-judge)
- Environment generation (N07) — synthetic edge cases from failures
- Evidence-gated promotion (F41)

---

## 7. Acceptance criteria

- [ ] PR touching prompt file triggers impact preview within 10 min
- [ ] 50-trace preview completes in <30 min with cached prefix
- [ ] PR comment shows divergence rate + regression eval failures
- [ ] Failed regression blocks merge when branch protection enabled
- [ ] MCP `preview_change_impact` returns same report as PR comment

---

*See [MARKET-HYPOTHESES.md](../MARKET-HYPOTHESES.md) §3.4.*
