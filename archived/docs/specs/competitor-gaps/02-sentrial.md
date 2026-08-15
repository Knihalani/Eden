# Sentrial Gap Implementation Specs

Competitor: **Sentrial** (YC W26) — https://www.sentrial.com

---

## Gap 2.1 — Zero-Config Semantic Issue Detection {#gap-21}

**Severity:** 🔴 | **Effort:** L

### Target

On SDK install, issues appear automatically — no signal/judge configuration. Detect: task failure, tool error, hallucination, user frustration, confusion loop, slow response, high cost.

### Current state

| Component | Path | Gap |
|---|---|---|
| RCA analyzer | `src/eden/insights/rca/analyzer.py` | On-demand per trace, rule-based |
| ETEC / loop detection | `eden-trace-quality-system-spec.md` | Hot-path guardrails, not issue feed |
| Incident clusterer | `src/eden/insights/incidents/clusterer.py` | Deterministic keys, manual cluster job |

### Architecture

**`src/eden/issues/auto_scanner.py`** — runs on `trace.finalized` event:

```
trace.finalized
    → AutoIssueScanner.scan(trace_id)
        → Rule pass (fast, <50ms): ETEC loop score, tool error spans, latency p99, cost z-score
        → Optional LLM pass (async, SLM): frustration, hallucination, task failure
    → IssueWriter.upsert_stumble(...)
    → if recurring → promote to Issue (see Gap 3.1)
```

**Default detectors (always on for org):**

| Detector ID | Source | Severity |
|---|---|---|
| `tool_error` | span `error=true` on TOOL spans | high |
| `loop_detected` | ETEC loop ensemble score > threshold | medium |
| `high_cost` | cost > μ + 3σ for agent | low |
| `slow_trace` | duration > p99 baseline | low |
| `task_failure` | `session.outcome=failure` or judge hallucination | high |
| `user_frustration` | regeneration + negative sentiment SLM | medium |
| `confusion_loop` | repeated identical user messages | medium |

### Data model

Reuse stumbles/issues tables from Gap 3.1 (`agent_stumbles`, `agent_issues`).

### SDK contract

Document that `complete_session(success=False, failure_reason=...)` improves detection (Sentrial parity) — add to Python/TS SDK:

```python
@eden.trace_agent
async def run(...):
    async with eden.session(agent_name="support") as s:
        ...
        s.complete(success=False, failure_reason="search_kb returned empty")
```

Implement `eden.session` context manager in `sdk/python/eden/session.py`.

### API

| Method | Path |
|---|---|
| `GET` | `/orgs/{org_id}/issues` — list with filters |
| `GET` | `/orgs/{org_id}/issues/{issue_id}` — detail + diagnosis |

### Feature flag

`auto_issue_detection_v1` — default **true** for new orgs, opt-in for existing.

### Tests

- Fixture traces for each detector type in `tests/fixtures/traces/issues/`
- `tests/unit/issues/test_auto_scanner.py` — 7 detectors × 2 cases

### Acceptance criteria

- [ ] New org with SDK only: first failing trace creates visible issue within 60s
- [ ] Zero NL signal or judge configuration required
- [ ] Issue list shows severity + type + trace link

---

## Gap 2.2 — Learn-from-Labeled Tool Calls {#gap-22}

**Severity:** 🔴 | **Effort:** L

### Target

Operator marks tool call ✓/✗ in UI; Eden learns embedding classifier for that agent's correct tool usage patterns.

### Architecture

**`src/eden/issues/tool_call_labels.py`**

1. UI action on trace tool row: `POST /orgs/{org_id}/traces/{trace_id}/tool-calls/{span_id}/label` `{correct: bool, note?: string}`
2. Feature extraction: `{agent_id, conversation_state_embedding, tool_name, tool_args_embedding, next_step_outcome}`
3. Store in `tool_call_labels` table
4. After ≥5 labels: train lightweight logistic regression or k-NN on embeddings (BGE-small)
5. `ToolCallCalibrator.predict(trace)` → anomaly score per tool call
6. Auto-flag when score < threshold → creates stumble `tool_misuse_learned`

### Data model

```sql
CREATE TABLE tool_call_labels (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL,
    agent_id TEXT NOT NULL,
    trace_id UUID NOT NULL,
    span_id UUID NOT NULL,
    correct BOOLEAN NOT NULL,
    note TEXT,
    feature_snapshot JSONB NOT NULL,
    labeled_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tool_call_calibrators (
    org_id UUID NOT NULL,
    agent_id TEXT NOT NULL,
    model_version INT NOT NULL,
    weights JSONB NOT NULL,
    label_count INT NOT NULL,
    metrics JSONB,
    PRIMARY KEY (org_id, agent_id)
);
```

### Portal

Tool row actions: ✓ Correct / ✗ Incorrect — modal optional note.

### Acceptance criteria

- [ ] After 10 labels on `search_kb` misuse, 8/10 similar misuse traces flagged automatically
- [ ] Per-agent calibrator visible in settings

---

## Gap 2.3 — Diagnosis → GitHub PR Chat Flow {#gap-23}

**Severity:** 🔴 | **Effort:** L

### Target

Sentrial parity: Issue page → "Fix in Code" → AI chat with issue + trace + repo context → diff → Create PR.

### Current state

| Component | Status |
|---|---|
| GitHub OAuth/App | Shipped — `github.py`, `GitHubPRProvider` |
| Cat 23 patch pipeline | Stub — gates 3/4 blocked |
| `agent_pr_suggestions` | Partial portal UX |
| Code indexer | **Missing** |

### Architecture

**Phase 1 (4 weeks) — MVP without auto-patch**

```
Issue detail page
  → "Fix in Code" opens /issues/{id}/fix
  → Backend loads: issue, traces, RCA, relevant files (GitHub API)
  → SSE chat (reuse ChatSidebar) with tools: read_file, search_repo, propose_diff
  → User approves diff → POST create PR (existing GitHubPRProvider)
```

**New services:**

- `src/eden/code_change/indexer.py` — shallow index: file tree + symbol map via tree-sitter; store in `repo_file_index`
- `src/eden/code_change/issue_fix_chat.py` — system prompt with issue bundle

**API:**

| Method | Path |
|---|---|
| `POST` | `/orgs/{org_id}/issues/{issue_id}/fix/chat` SSE |
| `POST` | `/orgs/{org_id}/issues/{issue_id}/fix/apply` → creates PR |
| `POST` | `/orgs/{org_id}/repos/{repo_id}/index` — trigger reindex |

**Phase 2:** Wire Cat 23 `PatchGenerator` when Gate 3 sandbox opens — chat can auto-propose patch.

### Portal

New route: `clients/portal/src/app/(portal)/issues/[issueId]/fix/page.tsx`

Reuse `ChatSidebar` + diff viewer component from PR suggestions.

### Feature flags

- `issue_fix_chat_v1` — default true
- Requires GitHub repo connected (existing onboarding)

### Acceptance criteria

- [ ] End-to-end: issue → chat → PR URL in GitHub within 10 min (happy path)
- [ ] Chat context includes failing trace tool call arguments
- [ ] No code stored server-side after session (Sentrial security parity)

---

## Gap 2.4 — Session-First Data Model {#gap-24}

**Severity:** 🟠 | **Effort:** M

### Target

SDK: `eden.session()` as primary unit; maps to OTel `session.id` + Eden `agent_sessions` table.

### Data model

```sql
CREATE TABLE agent_sessions (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL,
    agent_name TEXT NOT NULL,
    user_id TEXT,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    success BOOLEAN,
    failure_reason TEXT,
    estimated_cost_usd NUMERIC(12,6),
    trace_ids UUID[] NOT NULL DEFAULT '{}',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
```

### SDK API (Python)

```python
async with eden.session(agent_name="support", user_id="u-1") as session:
    session.track_tool_call(name="search", args={...}, result={...})
    session.track_decision(reason="escalate", metadata={...})
    session.complete(success=True, estimated_cost=0.02)
```

Implementation: `sdk/python/eden/session.py` → batches events → existing ingest pipeline with `session_id` on all spans.

### Acceptance criteria

- [ ] Portal `/sessions` lists sessions with outcome badges
- [ ] Issues link to session not only trace

---

## Gap 2.5 — Claude Code / Mastra One-Liner Integrations {#gap-25}

**Severity:** 🟠 | **Effort:** S

### Deliverables

| Integration | File | Lines to add |
|---|---|---|
| Claude Agent SDK (Py) | `docs/docs/integrations/claude-agent-sdk.md` | wrap `query()` |
| Claude Agent SDK (TS) | `docs/docs/integrations/claude-agent-sdk-ts.md` | wrap `query` |
| Mastra | `sdk/python/eden/integrations/mastra.py` | middleware |
| AutoGen | extend existing auto-instrument | callback |

Each doc: copy-paste block, env vars, link to auto issue detection.

### Acceptance criteria

- [ ] `time_to_first_issue` <5 min from cold start in docs walkthrough

---

## Gap 2.6 — CLI Session Inspection {#gap-26}

**Severity:** 🟡 | **Effort:** S

```bash
eden sessions list --since 24h --agent support
eden sessions show SESSION_ID --format json
eden sessions issues SESSION_ID
```

Implement in `sdk/cli/` calling Sessions API.

---

## Gap 2.7 — "Use with AI" Docs Page {#gap-27}

**Severity:** 🟡 | **Effort:** XS

Create `docs/docs/how-to/use-with-ai.md`:

- Link to `https://docs.edenobservability.com/llms.txt` (generate from Docusaurus)
- Prompt template for Cursor/Claude Code to instrument repo
- Mirror Sentrial's `use-with-ai.md` structure

Add to docs navbar under "Get Started".

### Acceptance criteria

- [ ] `llms.txt` lists all integration pages
- [ ] Page live on docs site
