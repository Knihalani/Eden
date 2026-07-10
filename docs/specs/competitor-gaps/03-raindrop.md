# Raindrop Gap Implementation Specs

Competitor: **Raindrop** (YC W24) — https://www.raindrop.ai · Workshop: https://raindrop.sh

---

## Gap 3.1 — Stumbles → Issues Hierarchy {#gap-31}

**Severity:** 🔴 | **Effort:** L

### Target

Sentry-style: **Stumble** (single failure) → **Issue** (recurring pattern) with user impact, severity, lifecycle.

### Current state

`incident_clusters` — deterministic `(category, error_type, agent_id)` buckets; no stumble layer, no user impact counts.

### Data model — Migration `077_agent_issues.sql`

```sql
CREATE TYPE stumble_kind AS ENUM (
    'tool_error', 'loop', 'hallucination', 'task_failure',
    'user_frustration', 'timeout', 'self_diagnostic', 'custom'
);

CREATE TABLE agent_stumbles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    trace_id UUID NOT NULL,
    session_id UUID,
    user_id TEXT,
    kind stumble_kind NOT NULL,
    fingerprint TEXT NOT NULL,  -- hash for grouping
    title TEXT NOT NULL,
    detail JSONB NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('p0','p1','p2','p3')),
    detected_by TEXT NOT NULL,  -- detector id
    detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    span_id UUID
);

CREATE TABLE agent_issues (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    fingerprint TEXT NOT NULL,
    kind stumble_kind NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','ignored','regressed')),
    severity TEXT NOT NULL,
    first_seen TIMESTAMPTZ NOT NULL,
    last_seen TIMESTAMPTZ NOT NULL,
    stumble_count INT NOT NULL DEFAULT 1,
    user_count INT NOT NULL DEFAULT 1,
    example_stumble_ids UUID[] NOT NULL,
    assignee UUID REFERENCES users(id),
    UNIQUE (org_id, fingerprint)
);

CREATE TABLE agent_issue_stumbles (
    issue_id UUID NOT NULL REFERENCES agent_issues(id) ON DELETE CASCADE,
    stumble_id UUID NOT NULL REFERENCES agent_stumbles(id) ON DELETE CASCADE,
    PRIMARY KEY (issue_id, stumble_id)
);

CREATE INDEX idx_stumbles_fingerprint ON agent_stumbles (org_id, fingerprint, detected_at DESC);
CREATE INDEX idx_issues_status ON agent_issues (org_id, status, severity);
```

### Fingerprint algorithm

```python
def stumble_fingerprint(kind: str, agent_id: str, error_signature: str) -> str:
    # error_signature: normalized tool name + error code + top stack frame OR loop hash
    raw = f"{kind}|{agent_id}|{error_signature}"
    return hashlib.sha256(raw.encode()).hexdigest()[:32]
```

### Issue promotion worker

On new stumble:
1. Upsert issue by `(org_id, fingerprint)`
2. Increment `stumble_count`, update `last_seen`
3. HyperLogLog or distinct count for `user_count`
4. If stumble_rate > threshold in 1h → bump severity, fire Slack alert

### Self-diagnostics (Raindrop 2.0)

SDK hook: `session.report_stumble(kind, title, detail)` — agent reports mid-run.

### API

| Method | Path |
|---|---|
| `GET` | `/orgs/{org_id}/agent-issues` |
| `GET` | `/orgs/{org_id}/agent-issues/{id}` |
| `GET` | `/orgs/{org_id}/agent-issues/{id}/stumbles` |
| `POST` | `/orgs/{org_id}/agent-issues/{id}/resolve` |
| `POST` | `/orgs/{org_id}/agent-issues/{id}/ignore` |

### Portal

Replace/enhance `/incidents` with Sentry-style issue list:
- Columns: Issue, Severity, Users, Events, Last seen, Assignee
- Detail: frequency chart, affected users table, example traces

### Migration from incident_clusters

One-time job: map existing clusters → agent_issues where possible.

### Acceptance criteria

- [ ] Same failure across 5 traces → 1 issue, stumble_count=5
- [ ] Resolve issue → status resolved; new stumble reopens (regressed)
- [ ] P0 issue Slack alert includes user_count

---

## Gap 3.2 — Triage Agent Productization {#gap-32}

**Severity:** 🔴 | **Effort:** M

### Target

One-click "Investigate" on issue → AI produces root cause summary + recommended fix + MCP bundle for coding agent.

### Current state

`src/eden/autonomous/investigation.py` — InvestigationAgent exists; not wired to issues UI.

### Architecture

**`src/eden/issues/triage_agent.py`**

Input bundle:
```json
{
  "issue": {...},
  "example_traces": ["id1", "id2", "id3"],
  "rca_summaries": [...],
  "related_deployments": [...],
  "signal_events": [...]
}
```

Agent tools: `get_trace_transcript`, `get_span_detail`, `query_similar_stumbles`, `get_prompt_version`, `get_recent_deploys`

Output:
```json
{
  "root_cause": "...",
  "confidence": 0.85,
  "contributing_factors": ["...", "..."],
  "recommended_fixes": [{"type": "prompt|code|tool", "description": "...", "file_hint": "..."}],
  "mcp_handoff": {"issue_id": "...", "trace_id": "...", "prompt": "..."}
}
```

Store in `agent_issues.triage_result JSONB`.

### API

| Method | Path |
|---|---|
| `POST` | `/orgs/{org_id}/agent-issues/{id}/triage` — async job |
| `GET` | `/orgs/{org_id}/agent-issues/{id}/triage` — poll result |

### Portal

Issue detail → "Triage" button → streaming markdown result → "Send to coding agent" copies MCP prompt.

### Acceptance criteria

- [ ] Triage completes <90s for issue with 3 example traces
- [ ] MCP handoff successfully consumed by Gap 1.2 tools

---

## Gap 3.3 — Interactive Slack Bot {#gap-33}

**Severity:** 🔴 | **Effort:** L

### Target

@app mentions in Slack: search traces, list issues, ack/resolve, create signal.

### Current state

Slack is **stub only** — `alert_stream.py` logs placeholder; `integrations/slack.py` **does not exist**.

### Architecture

**New:** `src/eden/integrations/slack/bot.py`

- Slack Bolt app (Events API + slash commands)
- OAuth install flow per org → store `slack_team_id`, `bot_token` encrypted
- Routes mounted at `/integrations/slack/events`

**Commands:**

| User input | Action |
|---|---|
| `@eden issues p0` | List P0 open issues |
| `@eden trace abc-123` | Link + summary |
| `@eden resolve issue-456` | POST resolve |
| `@eden search loop in checkout` | EQL/search |

**Alerts:** Replace webhook placeholder in `alert_stream.py` with Block Kit messages including user_count (Raindrop parity).

### Data model

```sql
CREATE TABLE slack_installations (
    org_id UUID PRIMARY KEY REFERENCES organizations(id),
    team_id TEXT NOT NULL UNIQUE,
    bot_token_encrypted TEXT NOT NULL,
    installed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Acceptance criteria

- [ ] Install Slack app from Eden settings
- [ ] P0 issue posts to `#ai-alerts` with buttons: View, Triage, Resolve
- [ ] @mention search returns trace link in thread

---

## Gap 3.4 — Eden Workshop (OSS Local Debugger) {#gap-34}

**Severity:** 🟠 | **Effort:** XL

### Target

Raindrop Workshop parity: free, local, OSS, one-line install, live trace streaming, coding-agent eval loop.

### Architecture

**New repo or monorepo package:** `workshop/` (publish as `@eden-ai/workshop` + PyPI `eden-workshop`)

Components:
1. **Local collector** — HTTP server `localhost:9477` receives OTLP-ish spans from SDK
2. **Live UI** — Vite SPA (or reuse portal components) served locally
3. **Eval runner** — reads trace, generates test file template, runs subprocess
4. **Coding agent bridge** — MCP tools pointing at localhost API

**Install:**

```bash
curl -fsSL https://edenobservability.com/workshop/install | bash
# or: npm i -g @eden-ai/workshop && eden-workshop serve
```

**SDK mode:**

```python
import eden
eden.workshop.init()  # sets exporter to localhost:9477
```

**Self-healing eval loop (Workshop parity):**

```
trace captured → Claude reads via MCP → writes tests/eval_issue_123.py
→ runs agent → fails → edits src/ → reruns until pass
```

### File structure

```
workshop/
  cli/main.ts
  server/collector.ts
  ui/  # TranscriptView ported to standalone
  mcp/server.ts
  templates/eval.ts.hbs
```

### Cloud optional

Workshop works offline; optional `eden-workshop login` syncs traces to cloud project.

### Acceptance criteria

- [ ] Install → run instrumented agent → trace visible in localhost UI <2s latency
- [ ] OSS license Apache 2.0
- [ ] Claude Code skill documented

---

## Gap 3.5 — Issue-Linked Production Experiments {#gap-35}

**Severity:** 🟠 | **Effort:** M

### Target

From issue page: "Run experiment" → feature-flag variant on live traffic → chart issue stumble rate control vs variant.

### Implementation

Extend Cat 12 + prompt canary:

```sql
ALTER TABLE agent_issues ADD COLUMN experiment_id UUID REFERENCES experiment_traffic_splits(id);
```

**Flow:**
1. `POST /agent-issues/{id}/experiments` `{variant_config, flag_key, traffic_pct}`
2. Creates Cat 12 experiment linked to issue fingerprint
3. Dashboard: stumble rate by variant (query stumbles JOIN experiment assignment)

**Reverse lookup:** `GET /experiments/{id}/issues` — which issues regressed/improved.

### Acceptance criteria

- [ ] Experiment shows issue stumble rate delta with Bayesian confidence (reuse Cat 12 winner detector)

---

## Gap 3.6 — Per-Product Trained Signal Classifiers {#gap-36}

**Severity:** 🟠 | **Effort:** XL

### Target

Raindrop-style: train small classifier per org/product on traces; default library (Forgetting, Laziness, Wins, etc.).

### Architecture

**`src/eden/signals/classifier_pipeline/`**

1. **Default library** — few-shot prompt templates + SLM heads for 8 Raindrop default signals
2. **Custom classifier** — when org enables signal:
   - Sample 500 traces (stratified)
   - Human labels optional (from stumbles)
   - Fine-tune LoRA on Qwen 3.5 4B OR train sklearn on embeddings
   - Deploy to inference worker
3. **Backfill** — score last 3 days on deploy
4. **Online** — score every incoming trace async

### Data model

```sql
CREATE TABLE signal_classifiers (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL,
    signal_name TEXT NOT NULL,
    model_artifact_uri TEXT NOT NULL,
    status TEXT CHECK (status IN ('training','active','failed')),
    metrics JSONB,
    trained_at TIMESTAMPTZ
);
```

### Acceptance criteria

- [ ] Default "User Frustration" fires on labeled fixture set F1 ≥ 0.75
- [ ] Training job completes ~1h for 100k traces (async job with progress)

---

## Gap 3.7 — Wins / Positive Signal Detection {#gap-37}

**Severity:** 🟡 | **Effort:** S

Add detectors: `user_praise`, `task_success`, `thumbs_up` (SDK instrumented).

```python
session.track_signal("win", metadata={"type": "thumbs_up"})
```

Surface in portal "Wins" tab → "Create eval from win" button.

---

## Gap 3.8 — Deep Search → Classifier Rules {#gap-38}

**Severity:** 🟡 | **Effort:** M

Portal NL search over traces → user refines → "Save as Signal" compiles to classifier or signal_definition.

Wire AI sidebar search (`ChatSidebar`) to persist query embeddings → cluster matching traces → generate rule.

---

## Gap 3.9 — Conversation UI Polish {#gap-39}

**Severity:** 🟡 | **Effort:** M

Raindrop parity UX improvements to `TranscriptView.tsx`:

- Notion-style blocks for user/assistant messages
- Parallel tool call lanes (horizontal swimlanes for concurrent tools)
- Inline image/screenshot thumbnails from computer_use
- Collapsible subagent cards with depth indicator
- Keyboard navigation (j/k between steps)

Design spec in `clients/portal/docs/transcript-ux-v2.md`; implement incrementally.

---

## Gap 3.10 — MCP run_autofix Loop {#gap-310}

**Severity:** 🟡 | **Effort:** M

MCP tool `eden_run_autofix`:

```
Input: { issue_id, repo_id, max_iterations: 3 }
Steps: triage → propose patch → run tests → open PR
```

Orchestrates Gap 2.3 + Cat 23 `PatchGenerator` + test runner.

Return: `{ pr_url, eval_passed, iterations }`

Feature flag: `mcp_autofix_v1` default false.
