# BentoLabs Gap Implementation Specs

Competitor: **BentoLabs AI** (YC Spring 2026) — https://bentolabs.ai

---

## Gap 4.1 — Runtime-Injected Nudges/Skills {#gap-41}

**Severity:** 🔴 | **Effort:** XL

### Target

Production-learned trigger-based fixes injected into live agent runs: skills, subagent hints, tool policies. Shadow → promote by evidence (Bento FAQ parity).

### Current state

| Component | Path | Gap |
|---|---|---|
| Procedural KB | `src/eden/kb/procedural/client.py` | Storage only, no runtime hook |
| StatGate | `eden-trace-quality-system-spec.md` | Gates guardrail actions, not nudges |
| Gateway | `src/eden/llmops/ai_gateway.py` | No skill injection point |

### Architecture

```
Agent request
    → AIGateway.pre_invoke hook
        → NudgeEngine.evaluate(context)
            → matching active nudges (trigger DSL)
            → if shadow: log only
            → if promoted: inject system message append / tool policy
    → LLM call
    → post_invoke: score outcome vs nudge intent
```

**`src/eden/nudges/engine.py`**

```python
class NudgeEngine:
    async def evaluate(self, ctx: AgentContext) -> list[NudgeAction]:
        ...

@dataclass
class Nudge:
    id: str
    org_id: str
    agent_id: str
    trigger: dict  # e.g. {"tool": "bash", "error_contains": "command not found"}
    action_type: Literal["system_append", "tool_block", "reroute", "subagent"]
    content: str  # markdown/yaml body
    mode: Literal["shadow", "promoted", "archived"]
    evidence: dict  # promotion stats
```

### Data model — Migration `078_nudges.sql`

```sql
CREATE TABLE nudges (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL,
    agent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    trigger JSONB NOT NULL,
    action_type TEXT NOT NULL,
    content TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'shadow',
    source_issue_id UUID REFERENCES agent_issues(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    promoted_at TIMESTAMPTZ,
    archived_at TIMESTAMPTZ
);

CREATE TABLE nudge_outcomes (
    id UUID PRIMARY KEY,
    nudge_id UUID NOT NULL REFERENCES nudges(id),
    trace_id UUID NOT NULL,
    mode TEXT NOT NULL,
    matched BOOLEAN NOT NULL,
    outcome_success BOOLEAN,
    metric_delta JSONB,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Nudge authoring pipeline

1. Recurring issue detected (Gap 3.1)
2. `NudgeAuthor` LLM drafts trigger + content from example traces
3. Created in `shadow` mode
4. `NudgePromotionWorker` runs StatGate-style checks:
   - n ≥ 30 shadow fires
   - success rate delta ≥ 5% (Cohen's d > 0.2)
   - no regression on secondary metrics
5. Auto-promote or queue for human approval

### SDK export (Bento parity — files in repo)

```bash
eden nudges export --agent support --output ./eden-nudges/
# writes markdown+yaml to customer repo
```

### Gateway hook

Modify `AIGateway.complete()`:

```python
nudge_actions = await nudge_engine.evaluate(ctx)
messages = apply_nudge_injections(messages, nudge_actions)
```

### Acceptance criteria

- [ ] Shadow nudge logs match without changing agent output
- [ ] Promoted nudge measurably fixes target failure on synthetic benchmark
- [ ] Export produces valid YAML in customer repo

---

## Gap 4.2 — "The Book" Agent Memory Artifact {#gap-42}

**Severity:** 🔴 | **Effort:** L

### Target

Human-readable compounding memory: failures, fixes, outcomes — consumable at inference time.

### Architecture

**`src/eden/book/generator.py`** — nightly + on issue resolve:

1. Aggregate closed issues + promoted nudges + RCA summaries
2. LLM synthesize chronological chapters per agent
3. Store as versioned markdown in `agent_books` table + S3 blob

```sql
CREATE TABLE agent_books (
    org_id UUID NOT NULL,
    agent_id TEXT NOT NULL,
    version INT NOT NULL,
    content_md TEXT NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (org_id, agent_id, version)
);
```

**Runtime consumption:**

```python
book_excerpt = await book_client.get_latest(org_id, agent_id, max_tokens=2000)
# Injected as system message section "## Institutional memory"
```

### Portal

`/agents/{id}/book` — markdown reader with diff between versions.

### Acceptance criteria

- [ ] Book updates within 1h of issue resolution
- [ ] Gateway injection capped at 2k tokens with citation links to traces

---

## Gap 4.3 — Evidence-Gated Promotion Pipeline {#gap-43}

**Severity:** 🔴 | **Effort:** L

### Target

Unified promotion lifecycle for nudges, auto-actions, and Cat 23 patches — shadow → score → promote/demote.

### Current state

- StatGate in trace quality spec — per guardrail action
- Cat 23 auto-approval stubs — separate system

### Architecture

**`src/eden/promotion/evidence_gate.py`** — generalize StatGate:

```python
class EvidenceGate:
    async def evaluate(self, candidate: PromotionCandidate) -> PromotionDecision:
        checks = [
            MinSampleCheck(n=30),
            EffectSizeCheck(cohens_d=0.2),
            RegressionCheck(secondary_metrics),
            ConformalCoverageCheck(),
        ]
```

Apply to:
- Nudges (Gap 4.1)
- Guardrail actions (existing)
- Cat 23 auto-merge PRs
- Prompt canary promotion

**`promotion_candidates` table** — unified queue in portal `/promotions`.

### Demotion

Post-promotion monitor: if 7-day rolling success drops >5% vs baseline → auto-archive + alert.

### Acceptance criteria

- [ ] Single portal view for all shadow-mode artifacts
- [ ] Demotion fires on synthetic regression within 1h

---

## Gap 4.4 — Behavioral Drift Pinpointing {#gap-44}

**Severity:** 🟠 | **Effort:** M

### Target

Detect behavior shift without code deploy — show **what** changed (tool distribution, prompt version, routing).

### Architecture

**`src/eden/drift/behavioral.py`**

Weekly baseline per agent:
- Tool call histogram
- Average steps to completion
- Model routing distribution
- Judge score means

Compare rolling 24h vs baseline (PSI + KL divergence):

```python
@dataclass
class DriftReport:
    agent_id: str
    shifted_dimensions: list[dict]  # {"dimension": "tool:bash", "baseline": 0.12, "current": 0.34, "psi": 0.21}
    likely_causes: list[str]  # prompt version change, model swap, traffic mix
```

Correlate with `prompt_version_assignments` and deploy events.

### API

`GET /orgs/{org_id}/agents/{agent_id}/drift`

### Acceptance criteria

- [ ] Detects model swap in A/B test within 24h
- [ ] Portal shows top 3 shifted dimensions with charts

---

## Gap 4.5 — NL Alerts + Real/Benign Triage {#gap-45}

**Severity:** 🟠 | **Effort:** M

Extend Phase Q signals + incident alerts:

When alert fires, **`AlertTriageJudge`** (SLM) classifies:
- `real_incident` — action required
- `benign` — expected variance (e.g. marketing campaign traffic spike)
- `duplicate` — same as open issue

Only `real_incident` pages on-call.

Store classification on `alert_events.triage_verdict`.

---

## Gap 4.6 — Auto-Curated Production Eval Datasets {#gap-46}

**Severity:** 🟠 | **Effort:** M

**`src/eden/datasets/auto_curator.py`**

Nightly job:
1. Cluster production traces by `(agent_id, outcome, intent_embedding)`
2. Sample representative traces per cluster
3. Write to `production_eval_datasets` with metadata slices
4. Trigger Cat 3 eval run on prompt/model changes (CI webhook)

```sql
CREATE TABLE production_eval_slices (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL,
    agent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    trace_ids UUID[] NOT NULL,
    cluster_centroid VECTOR(384),
    updated_at TIMESTAMPTZ NOT NULL
);
```

Portal: "Production datasets" tab with promote-to-golden action.

---

## Gap 4.7 — Long-Running Agent GTM Positioning {#gap-47}

**Severity:** 🟡 | **Effort:** XS (marketing)

Deliverables (no backend):
- Landing page section: "Built for agents that run minutes, not milliseconds"
- Case study template referencing coding/browser agents
- Docs page: `docs/docs/guide/long-running-agents.md` — retention, checkpointing, nudges

---

## Gap 4.8 — Zero-Label Improvement Loop UX {#gap-48}

**Severity:** 🟡 | **Effort:** S

Product/onboarding messaging + defaults:

1. Enable auto issue detection + shadow nudges by default for new orgs
2. Onboarding checklist: "First issue → first nudge candidate in 7 days" (Bento FAQ parity)
3. Empty state copy in portal explaining production traces = training data

Implementation: `clients/portal/src/app/(portal)/onboarding/improvement-loop.tsx`
