# N01: Production Trace → Regression Eval Pipeline

| Field | Value |
|---|---|
| **Feature ID** | N01 |
| **Slug** | `production-trace-regression-eval` |
| **Priority** | P0 |
| **Effort** | M |
| **Eden status** | **MISSING** |
| **Market hypothesis** | Eval+observability convergence — buyers want production failures to auto-become CI gates |
| **Dependencies** | F29 (issues), F44 (eval slices), F04 (MCP `add_trace_to_dataset`) |

---

## 1. Problem

When a production agent fails, teams manually copy traces into eval datasets. Raindrop/Bento/Langfuse are moving toward **"failure in prod → regression test in CI"** automatically. Eden has Cat 3 evals and F44 auto-curation stubs but **no closed pipeline** from issue resolution → permanent regression case → block bad deploys.

---

## 2. Target behavior

```
Production stumble (F28)
    → Issue promoted (F29)
    → Triage identifies root cause (F30)
    → On resolve: auto-create EvalCase from canonical example trace
    → EvalCase tagged issue_fingerprint — dedupe on recurrence
    → CI webhook on prompt/model change runs eval slice
    → Fail → block promotion (F41 EvidenceGate)
```

**User story:** Issue `#1847` (bash loop on macOS) resolved with nudge F39. Eden auto-adds 3 example traces to dataset `agent-checkout/regressions`. Next prompt deploy triggers eval — if bash loop recurs, promotion blocked.

---

## 3. Data model

```sql
ALTER TABLE eval_cases ADD COLUMN source_issue_id UUID REFERENCES agent_issues(id);
ALTER TABLE eval_cases ADD COLUMN source_trace_id UUID;
ALTER TABLE eval_cases ADD COLUMN fingerprint TEXT;
ALTER TABLE eval_cases ADD COLUMN auto_generated BOOLEAN DEFAULT false;

CREATE TABLE regression_eval_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    dataset_id UUID NOT NULL,
    trigger TEXT NOT NULL,  -- 'ci_webhook', 'manual', 'nightly'
    prompt_version_id TEXT,
    pass_rate FLOAT,
    new_failures UUID[],
    blocked_promotion BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now()
);
```

---

## 4. Architecture

| Component | Path | Role |
|---|---|---|
| `RegressionCaseBuilder` | `src/eden/evaluation/regression_builder.py` | Trace → EvalCase JSON |
| `IssueResolveHook` | `src/eden/issues/hooks/on_resolve.py` | Trigger on issue status=resolved |
| `CIWebhookHandler` | `src/eden/evaluation/ci_webhook.py` | GitHub/GitLab on prompt file change |
| `PromotionBlocker` | Integrates F41 | Fail regression → hold promotion |

**EvalCase shape:**
```json
{
  "input": {"messages": [...], "tools": [...]},
  "expected": {"no_stumble_kinds": ["loop"], "max_tool_calls": {"bash": 2}},
  "metadata": {"source_issue_id": "...", "fingerprint": "abc123"}
}
```

---

## 5. MCP / API

| Surface | Endpoint / tool |
|---|---|
| MCP | `add_trace_to_dataset`, `run_regression_eval` |
| REST | `POST /orgs/{id}/issues/{id}/create-regression-case` |
| REST | `POST /webhooks/ci/regression-eval` |
| Portal | Issue page → "Add to regression suite" button |

---

## 6. Market evidence

- Langfuse " datasets from production" GA 2025
- Braintrust "trace to testcase" workflow — top requested feature
- Enterprise RFP pattern: "show me how you prevent regressions after fixes"

---

## 7. Acceptance criteria

- [ ] Resolving issue with ≥1 example trace creates eval case within 60s
- [ ] Duplicate fingerprint does not create second case
- [ ] CI webhook on `prompts/*.yaml` change runs linked regression slice
- [ ] Failed regression blocks F41 promotion with clear error
- [ ] MCP tool `add_trace_to_dataset` works from Cursor workflow

---

*Extends F44; see [MARKET-HYPOTHESES.md](../MARKET-HYPOTHESES.md) §3.1.*
