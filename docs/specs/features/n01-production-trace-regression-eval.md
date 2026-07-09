# N01: Production Trace → Regression Eval Pipeline

| Field | Value |
|---|---|
| **Feature ID** | N01 |
| **Slug** | `production-trace-regression-eval` |
| **Priority** | P0 |
| **Effort** | M |
| **Eden status** | **MISSING** |
| **Market hypothesis** | Eval+observability convergence — buyers want production failures to auto-become CI gates |
| **Dependencies** | F29 (issues), F44 (eval slices), F04 (MCP), F41 (EvidenceGate), N22 (policy) |

---

## 1. Summary

When a production agent issue is resolved, Eden automatically materializes **permanent regression eval cases** from canonical example traces, dedupes by fingerprint, and runs them on every prompt/model/config change — blocking promotion via F41 when regressions recur. This closes the loop between **production maintenance** and **CI verification** that Raindrop, Langfuse, and Braintrust sell separately.

**Modes:**
- **Operator:** Issue page → "Add to regression suite" → manual confirm
- **Assisted autonomous (N22 T2+):** On `issue.resolved`, auto-create cases when `require_regression_pass=true`
- **Fully autonomous (T3):** CI webhook auto-runs + blocks merge without human

---

## 2. Eden current state

| Shipped | Path | Gap |
|---|---|---|
| Cat 3 eval engine | `evaluation/` | No issue-linked case builder |
| Eval datasets API | `api/routes/evaluation*.py` | No `source_issue_id` column |
| F44 auto-curation stub | spec only | No nightly curator wired |
| GitHub App hooks | partial | No CI regression webhook |
| MCP `add_trace_to_dataset` | F04 spec | Not implemented |
| F41 EvidenceGate | **MISSING** | Block path not wired |

**Greenfield:** `src/eden/evaluation/regression_builder.py`, `src/eden/issues/hooks/on_resolve.py` (depends on F29).

---

## 3. Target behavior

### 3.1 Operator flow (normal maintenance)

```
Production stumble (F28)
    → Issue promoted (F29)
    → Triage identifies root cause (F30)
    → Operator resolves issue with ≥1 example trace pinned
    → POST create-regression-case OR auto on resolve (policy)
    → EvalCase tagged issue_fingerprint — dedupe on recurrence
    → CI webhook on prompt/model change runs regression slice
    → Fail → block promotion (F41 EvidenceGate) + N17 card
```

**User story:** Issue `#1847` (bash loop on macOS) resolved with nudge F39. Eden auto-adds 3 example traces to dataset `agent-checkout/regressions`. Next prompt deploy triggers eval — if bash loop recurs, promotion blocked.

### 3.2 Autonomous flow (N22 gated)

```
issue.resolved
    → N22.may(create_regression_case) == allow
    → RegressionCaseBuilder.from_issue(issue, max_traces=3)
    → fingerprint dedupe check
    → if duplicate: link existing case, skip insert
    → enqueue CI webhook registration for agent dataset
    → N17 "Verify" column: regression run pending
```

On **T4 sandbox:** failed regression auto-reopens issue (F46 `REGRESSED` transition).

---

## 4. Architecture

| Component | Path | Role |
|---|---|---|
| `RegressionCaseBuilder` | `src/eden/evaluation/regression_builder.py` | Trace → EvalCase JSON |
| `IssueResolveHook` | `src/eden/issues/hooks/on_resolve.py` | Trigger on `issue.status=resolved` |
| `CIWebhookHandler` | `src/eden/evaluation/ci_webhook.py` | GitHub/GitLab on `prompts/**` change |
| `PromotionBlocker` | integrates F41 | Fail regression → hold promotion |
| `FingerprintDeduper` | `regression_builder.py` | SHA256 of stumble_kind + tool pattern + input hash |

**HookBus wiring:** subscribe to `issue.resolved` from F46 orchestrator; do not poll issues table.

**EvalCase shape:**

```json
{
  "input": {"messages": [...], "tools": [...]},
  "expected": {
    "no_stumble_kinds": ["loop"],
    "max_tool_calls": {"bash": 2},
    "statgate_pass": true
  },
  "metadata": {
    "source_issue_id": "...",
    "source_trace_ids": ["..."],
    "fingerprint": "abc123",
    "auto_generated": true,
    "triage_summary": "..."
  }
}
```

---

## 5. Data model

```sql
ALTER TABLE eval_cases ADD COLUMN IF NOT EXISTS source_issue_id UUID;
ALTER TABLE eval_cases ADD COLUMN IF NOT EXISTS source_trace_id UUID;
ALTER TABLE eval_cases ADD COLUMN IF NOT EXISTS fingerprint TEXT;
ALTER TABLE eval_cases ADD COLUMN IF NOT EXISTS auto_generated BOOLEAN DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS eval_cases_fingerprint_org_idx
    ON eval_cases (org_id, fingerprint) WHERE fingerprint IS NOT NULL;

CREATE TABLE regression_eval_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    dataset_id UUID NOT NULL,
    trigger TEXT NOT NULL,  -- 'ci_webhook', 'manual', 'nightly', 'autonomous'
    prompt_version_id TEXT,
    change_ref TEXT,          -- PR number or commit SHA
    pass_rate FLOAT,
    new_failures UUID[],
    blocked_promotion BOOLEAN DEFAULT false,
    policy_tier TEXT,         -- N22 tier that triggered run
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE regression_ci_webhooks (
    org_id UUID NOT NULL,
    agent_id TEXT NOT NULL,
    dataset_id UUID NOT NULL,
    github_repo TEXT NOT NULL,
    path_glob TEXT DEFAULT 'prompts/**',
    enabled BOOLEAN DEFAULT true,
    PRIMARY KEY (org_id, agent_id, github_repo)
);
```

---

## 6. API specification

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/orgs/{id}/issues/{id}/create-regression-case` | Manual create from issue |
| `POST` | `/orgs/{id}/issues/{id}/regression-cases` | Bulk from selected traces |
| `GET` | `/orgs/{id}/regression-runs?dataset_id=` | Run history |
| `POST` | `/webhooks/ci/regression-eval` | GitHub push/PR webhook |
| `POST` | `/orgs/{id}/regression-runs` | Manual trigger |

**MCP (F04):**

| Tool | Args | Returns |
|---|---|---|
| `add_trace_to_dataset` | `trace_id`, `dataset_id`, `expected` | `eval_case_id` |
| `run_regression_eval` | `agent_id`, `change_ref?` | `RegressionEvalRun` |
| `list_regression_failures` | `run_id` | failure details |

---

## 7. Implementation plan

### Phase 1 — Case builder (Week 1 scope)
1. Migration for `eval_cases` columns + `regression_eval_runs`
2. `RegressionCaseBuilder.from_trace()` — extract messages/tools from span store
3. Fingerprint: `sha256(stumble_kinds + sorted(tool_names) + first_user_msg_hash)`
4. Issue resolve hook (manual trigger only)

### Phase 2 — CI integration
1. GitHub webhook handler — detect `prompts/**`, `agent.yaml` diffs
2. Run linked dataset via existing eval runner
3. Post Check Run + PR comment (reuse F22 GitHub App)
4. F41 integration: `blocked_promotion=true` on fail

### Phase 3 — Autonomous (N22)
1. Auto-create on resolve when `policy.require_regression_pass`
2. N17 "Verify" column shows run status
3. N04 impact preview consumes same runner (shared `RegressionEvalService`)

---

## 8. SDK / MCP / Portal

**Portal:**
- Issue detail → "Regression suite" tab: linked cases, last run, pass rate trend
- Datasets → filter `auto_generated=true`
- Promotion flow (F41) shows blocking regression failures inline

**Portal components:** `clients/portal/src/app/(portal)/issues/[id]/regression/page.tsx`

---

## 9. Feature flags & rollout

| Flag | Default | Behavior |
|---|---|---|
| `regression_eval_v1` | off | Master switch |
| `regression_auto_on_resolve` | off | T2+ auto-create |
| `regression_block_promotion` | off | F41 hard block |

Rollout: internal org → 5 design partners → GA with N14 platform activation.

---

## 10. Test plan

| Test | Type | Assert |
|---|---|---|
| Resolve issue → case created | integration | `eval_cases.source_issue_id` set within 60s |
| Duplicate fingerprint | unit | second resolve skips insert |
| CI webhook prompt change | integration | run triggered, Check Run posted |
| Failed eval blocks F41 | integration | promotion status `blocked` |
| N22 T0 | integration | auto-create skipped |
| MCP add_trace | contract | case matches REST |

Fixtures: `tests/fixtures/regression/bash_loop_issue.json`, `tests/fixtures/regression/prompt_pr_webhook.json`

---

## 11. Acceptance criteria

- [ ] Resolving issue with ≥1 example trace creates eval case within 60s
- [ ] Duplicate fingerprint does not create second case
- [ ] CI webhook on `prompts/*.yaml` change runs linked regression slice
- [ ] Failed regression blocks F41 promotion with clear error
- [ ] MCP tool `add_trace_to_dataset` works from Cursor workflow
- [ ] N22 T0 org requires manual "Add to suite"
- [ ] Regression run logged in N06 audit ledger

---

## 12. Performance & cost optimization

### Latency budgets

| Operation | p50 | p95 | p99 |
|---|---|---|---|
| Case build from trace | 200ms | 800ms | 2s |
| Fingerprint dedupe lookup | 5ms | 20ms | 50ms |
| CI webhook ack | 50ms | 200ms | 500ms |
| Full regression run (50 cases) | 2min | 8min | 15min |

### Cost model

| Step | LLM tier | Est. $/1k ops |
|---|---|---|
| Case extraction | 0 (deterministic) | $0 |
| Eval run (judge suite) | SLM first | $0.50–2.00 per run |
| Cached-prefix replay (F01) | tail only | −60% vs full replay |

**Storage:** ~2KB/case metadata; trace refs by ID (N09 dedupe).

### Caching strategy

- Dataset case list: Redis 5min TTL
- Last run result: Redis 60s (N17 aggregator)
- Invalidation on new case or run complete

### Degradation modes

- Eval runner overloaded → queue CI runs, post "pending" Check Run
- F01 debugger unavailable → run judges on stored traces only (no replay)
- Budget exceeded (N22) → skip auto-runs, alert operator

### Monitoring

```
eden_regression_case_created_total{auto=bool}
eden_regression_run_duration_seconds
eden_regression_run_pass_rate
eden_regression_promotion_blocked_total
eden_regression_ci_webhook_total{status}
```

---

## 13. Dependencies

| Spec | Relationship |
|---|---|
| F29 | Issue source + example traces |
| F44 | Exploratory slices complement issue-driven cases |
| F41 | Promotion block on failure |
| N04 | Shared replay + eval runner |
| N17 | Verify column UX |
| N22 | Auto-create + block tiers |
| F46 | `issue.resolved` event bus |

---

*Extends F44; see [MARKET-HYPOTHESES.md](../MARKET-HYPOTHESES.md) §3.1, [AUTONOMOUS-MAINTENANCE.md](../AUTONOMOUS-MAINTENANCE.md).*
