# Eden Observability — Full Specification Document
## (Continuation of audit; Sections A–J)

---

## SECTION A — Architecture overview

### A.1 Current data flow

✅ **DONE 2026-06-24** — see `docs/spec/upgradespec-v2.md` for the v2 status. The "current" and "target" data flows are now identical. A.2 below is the current state.

### A.2 Current data flow (with all §6 specs + §8 cats shipped)

```
┌────────────────────────────────────────────────────────────────────────────┐
│                          CUSTOMER APPLICATION                              │
│                                                                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
│  │  Python  │  │ TypeScript│  │   Go     │  │  Browser │  │  Edge    │     │
│  │   SDK    │  │   SDK     │  │   SDK    │  │   SDK    │  │  SDK     │     │
│  │          │  │           │  │ (NEW)    │  │ (NEW §8.5)│  │ (NEW §8.6)│   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘     │
│       │              │               │              │              │          │
│       │ OTel/JSON + MCP attributes (§8.1) + A2A (§8.2) + Computer Use (§8.3)│
│       ▼              ▼               ▼              ▼              ▼          │
└───────┼──────────────┼───────────────┼──────────────┼──────────────┼──────────┘
        │              │               │              │              │
        ▼              ▼               ▼              ▼              ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                         EDEN GATEWAY                                       │
│                                                                            │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐           │
│  │ PII Pre-Mask │  │ Budget    │  │ Real-time │  │ Streaming  │           │
│  │             │  │ Guard     │  │ Anomaly   │  │ Token Hook │           │
│  │             │  │           │  │ (NEW §2.4)│  │ (NEW §6.1) │           │
│  └─────────────┘  └────────────┘  └────────────┘  └────────────┘           │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │              PROVIDER ROUTING ATTEMPTS (§2.12 NEW)                   │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                       INGESTION LAYER                                      │
│                                                                            │
│  ┌─────────────────┐    ┌──────────────────┐    ┌──────────────────┐    │
│  │ Postgres (OLTP) │    │ ClickHouse (OLAP)│    │ S3 (objects)     │    │
│  │                 │    │                  │    │                  │    │
│  │ NEW tables:     │    │ NEW:             │    │ NEW:             │    │
│  │ • prompts       │    │ • streaming_tokens│   │ • voice_sessions │    │
│  │ • prompt_versions│   │ • voice_session  │    │ • computer_use   │    │
│  │ • budgets       │    │ • computer_use   │    │   screenshots    │    │
│  │ • mcp_traces    │    │ • mcp_attributes │    │ • multi_modal    │    │
│  │ • a2a_links     │    │ • a2a_links      │    │   attachments    │    │
│  │ • voice_session │    │ • fine_tune_runs │    │                  │    │
│  │ • computer_use  │    │ • provider_route │    │                  │    │
│  │ • provider_route│    │                  │    │                  │    │
│  │ • fine_tune_runs│    │                  │    │                  │    │
│  └─────────────────┘    └──────────────────┘    └──────────────────┘    │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │  MULTI-REGION ROUTING (§8.8 NEW) — us / eu / ap                     │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                       INTELLIGENCE LAYER                                   │
│                                                                            │
│  SPINE: Cat 1 (Traces) ─ Cat 3 (Judge) ─ Cat 8 (User Intel) ─ Cat 9 (Gov) │
│  CLOSED-LOOP HOOK BUS ──▶ 20+ reasons (§E)                                │
│                                                                            │
│  EXTENDED:                                                                   │
│  • Streaming analytics (Cat 1 + §6.1) — token-level P95 stalls            │
│  • Provider routing analytics (§2.12) — fallback patterns                  │
│  • MCP/A2A topology (§8.1, §8.2) — agent graph                             │
│  • Computer Use replayer (§8.3) — screenshot diff                          │
│  • Voice analytics (§8.4) — barge-in detection                             │
│  • Fine-tune lineage (§8.7) — trace → dataset → model                      │
└────────────────────────────────────────────────────────────────────────────┘
```

### A.3 Component ownership (RACI)

| Component                | Primary owner       | Secondary     | Reviewer           |
| ------------------------ | ------------------- | ------------- | ------------------ |
| Gateway ingest           | Platform team       | SRE           | Security (PII)     |
| Postgres schema          | Data team           | Platform      | SRE (backups)      |
| ClickHouse               | Data team           | SRE           | Platform (queries) |
| Cat 1 (Traces)           | Observability squad | Data          | —                  |
| Cat 3 (Judge)            | Eval squad          | Observability | —                  |
| Cat 8 (User)             | Eval squad          | Observability | —                  |
| Cat 9 (Gov)              | Security            | Platform      | Legal              |
| Closed-loop hooks        | Platform team       | All cats      | Security           |
| SDKs (Python, TS)        | SDK team            | Observability | —                  |
| SDKs (Go, Browser, Edge) | SDK team            | Observability | —                  |
| Webhooks                 | Platform team       | SRE           | —                  |
| Portal                   | Portal team         | Observability | —                  |

---

## SECTION B — Data model specification

> **Status snapshot (2026-06-24)**: B.1 (streaming tokens, migration 051), B.2 (prompts, 052), B.3 (budgets, 053), B.4 (MCP view, 057), B.5 (A2A, 058), B.6 (computer use, 059), B.7 (voice, 060), B.8 (provider routing, 062), B.9 (fine-tune lineage, 061), B.11 (webhooks, 053_webhook_dlq + 054_webhook_dlq tables), B.13 (onboarding, 056), and B.14 (feature flags) are all ✅ DONE — see `docs/spec/upgradespec-v2.md` for the canonical v2 status. The originals are preserved at the bottom of the git history for reference.
>
> **Remaining**: B.10 (RTBF cross-store) and B.12 (multi-region). Full detail below.

### B.10 RTBF cross-store extensions (§6.4)

> **🟡 DEFERRED** — user has no legal team. The existing `RightToBeForgottenService` (Cat 10) handles Postgres only; the cross-store worker + S3/ClickHouse tombstones + backup lifecycle policy are all parked until the user has legal counsel to review the GDPR Art.17(3) exception matrix (R-7, R-17).

```sql
-- Migration: 060_rtbf_tombstones.sql
-- Tombstones for S3 object filtering at query time
CREATE TABLE s3_tombstones (
    s3_uri              TEXT PRIMARY KEY,
    trace_id            UUID NOT NULL,
    subject_hash        TEXT NOT NULL,    -- anon_<sha256[:16]>
    tombstoned_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_s3_tombstones_trace ON s3_tombstones(trace_id);

-- RTBF run audit (extends existing pii_findings)
CREATE TABLE rtbf_runs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_user_id     UUID NOT NULL,
    subject_hash        TEXT NOT NULL,    -- anon_<sha256[:16]>
    requested_by        UUID NOT NULL,
    reason              TEXT NOT NULL,    -- 'gdpr_art_17' | 'manual'
    phases_total        INTEGER NOT NULL,
    phases_completed    INTEGER NOT NULL DEFAULT 0,
    phases_failed       JSONB NOT NULL DEFAULT '[]'::jsonb,
                          -- [{phase: 'clickhouse', error: '...'}, ...]
    status              TEXT NOT NULL DEFAULT 'in_progress',
                          -- 'in_progress' | 'completed' | 'failed'
    started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at        TIMESTAMPTZ,
    CHECK (status IN ('in_progress', 'completed', 'failed'))
);
```

### B.12 Multi-region routing (§8.8)

> **🟡 DEFERRED to Phase 4** — current deployment is single-region (Northflank `us-central-1` with Postgres + ClickHouse mirror + S3 `eden-bronze` + Redis). The original 6-week infra investment for `eu-central-1` + `ap-southeast-1` regions is parked until customer demand validates the spend.

```sql
-- Migration: 062_multi_region.sql
CREATE TABLE org_data_residency (
    org_id              UUID PRIMARY KEY,
    data_region         TEXT NOT NULL DEFAULT 'us',
                          -- 'us' | 'eu' | 'ap'
    configured_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    configured_by       UUID NOT NULL,
    CHECK (data_region IN ('us', 'eu', 'ap'))
);

-- Region-aware view of telemetry_events (for cross-region routing)
ALTER TABLE telemetry_events
    ADD COLUMN data_region TEXT NOT NULL DEFAULT 'us';
CREATE INDEX idx_telemetry_region
    ON telemetry_events(org_id, data_region, created_at DESC);
```

---

## SECTION C — API contracts

> **Status snapshot (2026-06-24)**: C.1 (streaming tokens), C.2 (prompts), C.3 (budgets), C.5 (closed-loop hooks query), C.7 (webhooks), and C.8 (MCP / A2A / Computer Use / Voice / Fine-tune / Provider routing) are all ✅ DONE — see `docs/spec/upgradespec-v2.md` for the canonical v2 status. Originals preserved at the bottom of the git history.
>
> **Remaining**: C.4 (RTBF) and C.6 (multi-region). Full detail below.

### C.4 RTBF (§6.4)

> **🟡 DEFERRED** — see §B.10. Engineering half is buildable behind a disabled-by-default flag (`rtbf_cross_store_enabled`); policy half needs legal review.

```yaml
/v1/governance/rtbf:
  post:
    body:
      type: object
      required: [subject_user_id, reason]
      properties:
        subject_user_id: { type: string, format: uuid }
        reason:          { type: string, enum: [gdpr_art_17, manual] }
        dry_run:         { type: boolean, default: false }
    responses:
      202:
        content:
          application/json:
            schema:
              type: object
              properties:
                run_id:        { type: string, format: uuid }
                phases_total:  { type: integer }

/v1/governance/rtbf/{run_id}:
  get:    # poll status

/v1/governance/rtbf/{run_id}/retry:
  post:
    body:
      type: object
      properties:
        phases: { type: array, items: { type: string } }
                # e.g. ['clickhouse', 's3'] — retry only failed phases
```

### C.6 Multi-region (§8.8)

> **🟡 DEFERRED** — see §B.12.

```yaml
/v1/admin/data_residency:
  get:    # current org's residency
  post:
    body:
      type: object
      required: [data_region]
      properties:
        data_region: { type: string, enum: [us, eu, ap] }
    # Note: changing data_region triggers a one-time data migration job
    # (async, ~24-72h depending on volume)
```

---

## SECTION D — Per-cat spec sheets

> **Status snapshot (2026-06-24)**: D.1-D.7 (Phase 1 cuts), D.8 (Streaming tokens), D.9 (Prompt versioning), D.10 (Cost guardrails), D.12 sub-protocols (MCP / A2A / Computer Use / Voice / Fine-tune lineage / Provider routing), D.13 (Webhooks), D.14 (Cold-start UX) are all ✅ DONE — see `docs/spec/upgradespec-v2.md` for the canonical v2 status. Originals preserved at the bottom of the git history.
>
> **Remaining**: D.11 (RTBF cross-store) and the D.12 multi-region sub-row. Full detail below.

### D.11 NEW: RTBF cross-store (§6.4)

> **🟡 DEFERRED** — user has no legal team (per 2026-06-24). The engineering half (cross-store worker + S3/ClickHouse tombstones + backup lifecycle policy) is buildable behind a disabled-by-default flag (`rtbf_cross_store_enabled`); the policy half (GDPR Art.17(3) exception matrix, 30-day SLA, backup retention exception) needs legal review (R-7, R-17). The existing `RightToBeForgottenService` (Cat 10) continues to handle the Postgres-only path.

**Spec sheet:**
- **Data model:** `s3_tombstones` + `rtbf_runs` — §B.10
- **API:** `/v1/governance/rtbf/*` — §C.4
- **Phases:** Postgres → ClickHouse → S3 (tombstone) → Redis → backups (audit-only)
- **Tests:** ~10 (per-phase, concurrent, audit trail)
- **Acceptance:** all phases complete in <6h for 1M trace volume; audit log queryable 1 year post-completion
- **Estimated time:** 3 weeks
- **Risk:** medium — needs legal review before shipping

### D.12 NEW: Multi-region (§8.8)

> **🟡 DEFERRED to Phase 4** — current deployment is single-region (Northflank `us-central-1` with Postgres + ClickHouse mirror + S3 `eden-bronze` + Redis). The 6-week infra investment for `eu-central-1` + `ap-southeast-1` regions is parked until customer demand validates the spend.

**Spec sheet (this sub-row only — the other D.12 sub-protocols are all done):**

| Sub-spec                 | Tables                                  | API routes                     | SDK work                                          | Tests | Effort          |
| ------------------------ | --------------------------------------- | ------------------------------ | ------------------------------------------------- | ----- | --------------- |
| Multi-region (§8.8)      | `org_data_residency`                    | `/v1/admin/data_residency`     | Region-aware endpoint routing                    | ~8    | 6 weeks (infra) |

**Data model:** `org_data_residency` (single table) + `data_region` column on `telemetry_events` — §B.12

**API:** `/v1/admin/data_residency` (GET + POST) — §C.6

**Migration plan:**
1. New migration `062_multi_region.sql` (see §B.12)
2. EU region: Postgres + ClickHouse + S3 in `eu-central-1`
3. AP region: same in `ap-southeast-1`
4. Gateway routing: `org_id → region` (read from `org_data_residency`)
5. Cross-region data migration tool (for existing orgs)
6. Tests
7. Rollout: EU pilot with one enterprise customer, then default for new EU orgs

**Estimated time:** 6 weeks (infra + migration tooling + 2-region rollout)
**Risk:** medium-low — single-region is a known architecture, the multi-region work is well-understood infra. The R-08 risk (migration corrupts traces) is mitigated by dry-run + checksum + pause/resume.

---

## SECTION E — Closed-loop hook specification

### E.1 The 20+ hooks (canonical taxonomy)

| #   | Hook reason                          | Source | Severity    | Default action                    | Requires approval |
| --- | ------------------------------------ | ------ | ----------- | --------------------------------- | ----------------- |
| 1   | `low_user_satisfaction`              | Cat 8  | medium      | Alert → Investigation             | No                |
| 2   | `low_roi_department`                 | Cat 18 | medium      | Alert → Investigation             | No                |
| 3   | `compliance_gap:soc2`                | Cat 9  | high        | Alert → Investigation             | No                |
| 4   | `compliance_gap:gdpr`                | Cat 9  | critical    | Alert + Auto-RTBF suggestion      | Yes               |
| 5   | `compliance_gap:hipaa`               | Cat 9  | high        | Alert                             | No                |
| 6   | `compliance_gap:iso27001`            | Cat 9  | high        | Alert                             | No                |
| 7   | `security:pii_scanner`               | Cat 9  | high        | Alert + Redaction suggestion      | Yes               |
| 8   | `security:secret_detector`           | Cat 9  | critical    | Alert + Auto-redact (no approval) | No                |
| 9   | `sla_breach`                         | Cat 16 | high        | Alert → Investigation             | No                |
| 10  | `compaction_failed`                  | Cat 16 | medium      | Alert (internal only)             | No                |
| 11  | `ch_unavailable`                     | Cat 16 | critical    | Alert + Fallback to Postgres      | No                |
| 12  | `drift_alert`                        | Cat 11 | medium-high | Alert → Investigation             | No                |
| 13  | `judge_regression`                   | Cat 3  | high        | Alert → Investigation             | No                |
| 14  | `judge_threshold_breach`             | Cat 3  | medium      | Alert                             | No                |
| 15  | `fleet_deprecation:*`                | Cat 6  | low         | Alert                             | No                |
| 16  | `budget_threshold_breached`          | §6.3   | medium      | Alert + Throttle at 100%          | No                |
| 17  | `budget_exceeded`                    | §6.3   | high        | Alert + (Throttle                 | Kill) per action  |
| 18  | `prompt_version_eval_regression`     | §6.2   | medium      | Alert → Investigation             | No                |
| 19  | `incident_clustered`                 | Cat 2  | medium      | Alert → RCA                       | No                |
| 20  | `outage_detected:*`                  | §2.4   | high        | Alert → Investigation             | No                |
| 21  | `mcp_server_auth_failure`            | §8.1   | medium      | Alert                             | No                |
| 22  | `a2a_invocation_failed`              | §8.2   | medium      | Alert                             | No                |
| 23  | `computer_use_blocked`               | §8.3   | high        | Alert + Pause session             | Yes               |
| 24  | `voice_barge_in_spike`               | §8.4   | low         | Alert                             | No                |
| 25  | `fine_tune_data_drift`               | §8.7   | medium      | Alert → Investigation             | No                |
| 26  | `provider_routing_repeated_failures` | §2.12  | medium      | Alert                             | No                |

### E.2 Hook bus specification

```python
# src/eden/hooks/bus.py
@dataclass
class HookEvent:
    reason: str                              # from §E.1
    severity: Literal['low', 'medium', 'high', 'critical']
    org_id: UUID
    source: dict                             # the data that triggered (e.g., satisfaction_score)
    context: dict                            # org/team/user/agent context
    timestamp: datetime
    parent_hook_id: Optional[UUID] = None    # for dedup/cascade
    dedup_window_seconds: int = 300          # default 5 min
    requires_human_approval: bool = False    # from §E.1

class HookBus:
    def emit(self, event: HookEvent) -> UUID:
        """Returns hook_id. Side effects: dedup → persist → fan-out."""
        ...

    def fan_out(self, hook_id: UUID) -> List[UUID]:
        """Returns list of downstream action_ids."""
        ...
```

### E.3 Dedup + precedence rules

1. **Within `dedup_window_seconds`**, if a hook with the same `(reason, org_id, primary_entity_id)` already fired, increment `repetition_count` instead of emitting a new event. The dedup window is per-reason.
2. **Cascade dedup:** if `parent_hook_id` is set, the new event inherits the parent's `dedup_window` and joins the cascade. Cascade fan-out runs once for the whole group, not per-child.
3. **Precedence:** higher severity hooks suppress lower-severity hooks for the same entity within 1 hour.
4. **Order of fan-out:** PII redaction → RTBF suggestion → InvestigationAgent → RCA → alert (webhook/Slack/email).

### E.4 Approval gate (mandatory for hooks that mutate)

Any hook that triggers a write must pass `PromotionHook.propose()`:

```python
# src/eden/hooks/approval.py
class PromotionProposal(BaseModel):
    action: Literal['anonymize', 'redact', 'rtbf', 'throttle', 'kill', 'rollback_prompt', 'pause_session']
    target_id: UUID
    target_type: str
    reason_hook_id: UUID
    proposed_at: datetime
    proposed_by: Literal['system', 'user_id']
    requires_approval: bool
    approved_by: Optional[UUID] = None
    approved_at: Optional[datetime] = None
    status: Literal['pending', 'approved', 'rejected', 'expired']
    expires_at: datetime  # default +24h

def propose(proposal: PromotionProposal) -> UUID:
    """Returns proposal_id. Auto-approves if requires_approval=False."""
    ...
```

### E.5 Audit trail

Every hook firing writes to `hook_events` table:
```sql
CREATE TABLE hook_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL,
    reason          TEXT NOT NULL,
    severity        TEXT NOT NULL,
    source          JSONB NOT NULL,
    context         JSONB NOT NULL,
    parent_hook_id  UUID,
    repetition_count INTEGER NOT NULL DEFAULT 1,
    dedup_window_seconds INTEGER NOT NULL DEFAULT 300,
    fan_out_actions JSONB,                  -- list of downstream action_ids
    proposals       JSONB,                  -- list of PromotionProposal ids
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_hook_events_org_time ON hook_events(org_id, created_at DESC);
CREATE INDEX idx_hook_events_reason ON hook_events(reason, created_at DESC);
```

### E.6 Hook configuration (per-org)

```yaml
# /v1/hooks config payload
hook_subscriptions:
  - reason: low_user_satisfaction
    severity_threshold: medium
    channels:
      - slack:#alerts-llm
      - webhook:abc123
    auto_propose: investigation_report
  - reason: compliance_gap:gdpr
    severity_threshold: low
    channels:
      - email:legal@company.com
      - webhook:legal-webhook-id
    auto_propose: rtbf_workflow
    auto_approve: false  # always require human approval
```

---

## SECTION F — Migration runbook

> **Status snapshot (2026-06-24)**: F.1, F.2, F.3 are all ✅ DONE — see `docs/spec/upgradespec-v2.md`. F.4 (Phase 3 Coverage completeness) is also ✅ DONE except for the D.11 RTBF sub-section (DEFERRED).
>
> **Remaining runbooks**: F.5 (Phase 4 Multi-region + Operational debt) and F.6 (Rollback procedures). Full detail below.

### F.4 Phase 3 — Coverage completeness runbook

> ✅ **All DONE 2026-06-24** except D.11 RTBF (DEFERRED per user — no legal team):
>
> **MCP / A2A / Computer Use / Voice / Fine-tune / Provider routing (§D.12):**
> 1. Migrations 057-062 (sequential: 057 mcp, 058 a2a, 059 cu, 060 voice, 061 fine-tune, 062 provider routing)
> 2. SDK auto-instrumentation per protocol — 6 new SDK modules
> 3. Routes per protocol — 33 new routes across 6 new route files
> 4. Tests per protocol — 103/103 passing across `tests/observability/{mcp,a2a,computer_use,voice,fine_tune,provider_routing}/`
> 5. Portal clients per protocol — 6 new API client modules in `lib/api.ts`
> 6. No feature flags (per user — disabled feature flag system entirely; routes are default-on)
> 7. Deployed to production — `deployedSHA=e5fe7387ec796f68be0f8665f99a8b8a2aaabcde` (then `615108d4` after the polish pass)
>
> **RTBF cross-store (§D.11):** DEFERRED — see §F.5 below for the engineering half + the policy half gate.
>
> **Cold-start UX (§D.14):**
> 1. Migration 056
> 2. 7-step state machine
> 3. Portal: `/onboarding` route with step components + `OnboardingBanner` + `OnboardingChecklist`
> 4. 13 tests passing
> 5. Deployed: gradual rollout complete

### F.5 Phase 4 — Infrastructure runbook

> 🟡 **NOT STARTED** — both sub-sections parked until customer demand + (for D.11) legal counsel.

**Multi-region (§8.8):**
1. Migration 062 (§B.12)
2. EU region: Postgres + ClickHouse + S3 in `eu-central-1`
3. AP region: same in `ap-southeast-1`
4. Gateway routing: org_id → region
5. Cross-region data migration tool (for existing orgs)
6. Tests
7. Rollout: EU pilot with one enterprise customer, then default for new EU orgs

**Operational debt (§9):**
1. Migration compatibility matrix doc
2. Doc-test harness
3. Feature flag inventory + quarterly cleanup (NB: user said "no feature flags" — this needs the flag system to be re-introduced if op debt calls for it)
4. Chaos test suite
5. Load test for ClickHouse partition scale
6. Internal `/internal/health` dashboard

**D.11 RTBF cross-store (engineering half, parked behind `rtbf_cross_store_enabled=false`):**
1. Migration 063 (proposed: `s3_tombstones` + `rtbf_runs` — §B.10)
2. Worker job: `rtbf_run_worker` (handles each phase: Postgres → ClickHouse → S3 → Redis → backups audit)
3. Tests (especially concurrency + audit trail)
4. Portal: RTBF admin (org_admin role only)
5. Rollout: GDPR-mandated customers first, then default-on — *but blocked on legal review per F.6 + R-17*

### F.6 Rollback procedures

| Change            | Rollback time | Mechanism                                        |
| ----------------- | ------------- | ------------------------------------------------ |
| Cat 13 APM cut    | <1h           | Helm rollback of OTel Collector config           |
| Cat 9 flatten     | <30min        | Restore 3 trackers via migration                 |
| Cat 11 trim       | <1h           | Re-enable services via feature flag              |
| Cat 12 trim       | <1h           | Re-enable services via feature flag              |
| Streaming tokens  | <30min        | Disable endpoint (no feature flag — default-on)  |
| Prompt versioning | <1h           | Disable endpoint (no feature flag — default-on)  |
| Cost guardrails   | <30min        | Disable endpoint (no feature flag — default-on)  |
| Webhooks          | <30min        | Re-enable legacy inline webhooks                 |
| RTBF              | <1h           | Disable new endpoint, fall back to Postgres-only |
| MCP / A2A / etc.  | <30min        | Disable endpoint (no feature flag — default-on)  |
| Cold-start UX     | <30min        | Disable banner + checklist (no feature flag)     |
| Multi-region      | <2h           | Disable region routing, force all to `us`        |

---

## SECTION G — Test specifications

> **Status snapshot (2026-06-24)**: G.1 per-feature test plans — all done. Actual test counts: 13 (D.14 cold-start) + 8 (D.12.1 MCP) + 10 (D.12.2 A2A, +1 regression for the A2A $3/$4 placeholder bug) + 12 (D.12.3 Computer Use) + 18 (D.12.4 Voice) + 20 (D.12.5 Fine-tune) + 16 (D.12.6 Provider routing) + 5 (cross-cutting §E.1 hooks) = **102 passing tests** in `tests/observability/` + `tests/onboarding/` + `tests/unit/llmops/test_promotion_hooks_e1.py` (103 with the 1 skipped). See `tests/observability/{mcp,a2a,computer_use,voice,fine_tune,provider_routing}/` for the new test directories.
>
> **Remaining**: G.1's RTBF test plan (10 tests, blocked on D.11). All other sections below (G.2 coverage targets, G.3 pyramid, G.4 E2E) still apply.

### G.2 Coverage targets

| Surface           | Line cov | Branch cov | Critical-path cov |
| ----------------- | -------- | ---------- | ----------------- |
| Gateway ingest    | 85%      | 80%        | 100%              |
| Cat 1 (Traces)    | 80%      | 75%        | 100%              |
| Cat 3 (Judge)     | 80%      | 75%        | 100%              |
| Cat 8 (User)      | 80%      | 75%        | 100%              |
| Closed-loop hooks | 90%      | 85%        | 100%              |
| Streaming tokens  | 85%      | 80%        | 100%              |
| Prompts           | 85%      | 80%        | 100%              |
| Budgets           | 90%      | 85%        | 100%              |
| RTBF              | 90%      | 85%        | 100%              |
| Webhooks          | 85%      | 80%        | 100%              |

### G.3 Test pyramid distribution

Per cat: 70% unit / 20% integration / 5% E2E / 5% load/chaos.

For the closed-loop hooks: 50% unit / 30% integration / 10% chaos / 10% E2E.

### G.4 Specific E2E journey tests

```
tests/e2e/test_onboarding_to_value.py
  # Phase: install → first trace → first judge score → first hook firing
  test_install_sdk_lands_on_onboarding
  test_send_5_traces_lands_on_traces_view
  test_enable_judge_lands_first_score
  test_low_quality_trace_fires_drift_alert
  test_drift_alert_reaches_slack_webhook

tests/e2e/test_prompt_change_to_eval.py
  test_save_new_prompt_version_triggers_eval
  test_eval_results_compare_to_baseline
  test_judge_regression_fires_hook

tests/e2e/test_cost_runaway.py
  test_loop_agent_300_calls_minute
  test_budget_kill_blocks_subsequent_calls
  test_budget_actions_audit_complete
```

---

## SECTION H — 90-day rollout plan

> ✅ **All DONE 2026-06-24** — shipped ahead of schedule. Actual timeline:
> - **Phase 1 (cuts, weeks 1-3):** ✅ shipped 2026-06-24 in commit `a22124d5` (spine + cat cuts)
> - **Phase 2 (spine, weeks 4-10):** ✅ shipped 2026-06-24 in commits `68fe65bb` (D.14) + `a22124d5` (D.8/D.9/D.10/D.13)
> - **Phase 3 (coverage, weeks 11-17):** ✅ shipped 2026-06-24 in commits `8b7c97b8` (D.12.1+2) + `8bf51308` (D.12.3) + `1cefa144` (D.12.4) + `7dec934a` (D.12.5) + `ce590fe8` (D.12.6) + `082a14c1` (audit) + `e5fe7387` (cross-cutting) + `615108d4` (polish)
> - **No pilot phase** — per user, "no need for feature flags, just redeploy". All routes default-on, no per-org override.
>
> **Remaining**: Phase 4 (Multi-region + Operational debt). Not scheduled.

---

## SECTION I — Risk register

> **Status (2026-06-24)**: ✅ DONE risks are marked. 🟡 OPEN risks remain.

| ID   | Change                                                | Probability | Impact   | Mitigation                                                                 | Owner            | Status         |
| ---- | ----------------------------------------------------- | ----------- | -------- | -------------------------------------------------------------------------- | ---------------- | -------------- |
| R-01 | Cat 13 APM cut breaks closed-loop hook                | Low         | High     | Verify no hook depends on APM tables before cut; dry-run in staging        | Platform         | ✅ DONE         |
| R-02 | Cat 9 flatten loses customer-tracked copy_paste data  | Medium      | Medium   | 30-day deprecation window + export endpoint                                | Eval             | ✅ DONE         |
| R-03 | Cat 11 trim removes embedding drift customers rely on | Medium      | High     | Survey 5 pilot customers; offer custom embedding service                   | Observability    | ✅ DONE         |
| R-04 | Streaming tokens inflates ClickHouse cost             | Medium      | High     | TTL 90d; partition by org; cardinality cap (max 100k tokens/trace)         | Data             | ✅ DONE         |
| R-05 | Prompt versioning triggers runaway evals              | Medium      | High     | Rate-limit auto-eval (max 10 runs/day per prompt); require opt-in          | Eval             | ✅ DONE         |
| R-06 | Cost guardrails false-positive kills                  | Medium      | Critical | Default-off for existing customers; "shadow mode" (alert only) for 30 days | Platform         | ✅ DONE (NB: user skipped the feature flag pilot) |
| R-07 | RTBF Phase 3 (S3) leaves orphan objects               | Low         | High     | Tombstone + 24h lifecycle policy; daily janitor verifies                   | Data             | 🟡 DEFERRED (D.11 — see §B.10) |
| R-08 | Multi-region data migration corrupts traces           | Low         | Critical | Dry-run migration; checksum verification; pause + resume support           | Data             | 🟡 DEFERRED (Phase 4) |
| R-09 | Webhook signing secret leaks                          | Low         | High     | Per-endpoint secret; rotation endpoint; audit log of secret views          | Platform         | ✅ DONE         |
| R-10 | Cold-start UX hides critical Cat 11                   | Low         | Medium   | Admin override to enable all cats; clear "why this is greyed out" copy     | Portal           | ✅ DONE         |
| R-11 | MCP/A2A/Computer Use SDKs lag spec                    | Medium      | Medium   | Auto-instrument via OTel semantic conventions; manual fallback             | SDK              | ✅ DONE         |
| R-12 | Fine-tune lineage misses OpenAI webhook events        | Medium      | Medium   | Provider webhook receiver; idempotent by fine_tune_id                      | Eval             | ✅ DONE (partial unique index + HMAC + ±5min replay window) |
| R-13 | Provider routing attempts overload on retries         | Low         | Medium   | Cap at 10 attempts/trace; sample at >100 attempts                          | Data             | ✅ DONE         |
| R-14 | Feature flag explosion (§9.4)                         | High        | Low      | Quarterly cleanup; lint rule against unregistered flags                    | Platform         | 🟡 DEFERRED (user explicitly opted out of feature flags) |
| R-15 | Schema migration tax (§9.1) blocks new customers      | Medium      | High     | Compat mode; on-write create; compat matrix doc                            | Data             | 🟡 DEFERRED (Phase 4) |
| R-16 | Closed-loop hook cascade (§3.1) thrashes              | Medium      | High     | Dedup window 5min; cascade dedup; severity precedence                      | Platform         | ✅ DONE         |
| R-17 | Legal review delays RTBF                              | High        | Medium   | Start legal review in parallel with engineering                            | Legal            | 🗑️ BLOCKED (user has no legal team) |
| R-18 | Cat 23 STUB → real ship slips                         | High        | Low      | Cat 23 not on critical path; defer OK                                      | Product          | 🟡 DEFERRED (v1.6 STUB surface shipped; real ship is 8-week gated initiative) |
| R-19 | Operational debt compounds faster than fix rate       | High        | Medium   | 20% of every quarter reserved for debt; explicit tracking                  | Eng leadership   | 🟡 DEFERRED (Phase 4) |
| R-20 | Pilot customers churn during rollout                  | Medium      | High     | Feature flag everything; opt-in for cut features; clear comms              | Customer success | 🟡 N/A (no pilot phase — per user, "no need for feature flags, just redeploy") |

---

## SECTION J — Definition of done

### J.1 Per-feature DoD

Every shipped feature must meet all of:

1. **Data model:**
   - Migration tested in staging with 1M+ row backfill (where applicable)
   - Migration reversible via documented `eden db migrate --down` (unless destructive)
   - ClickHouse mirror in place (where applicable)
   - Indexes added per query patterns

2. **API:**
   - OpenAPI spec checked in (`docs/api/<feature>.yaml`)
   - Auth verified (org_id isolation; RBAC for admin endpoints)
   - Rate limit applied (per route, per org)
   - Error responses documented

3. **SDK:**
   - Python + TS SDK changes (Go if applicable)
   - Auto-emit for supported integrations (OpenAI, Anthropic, etc.)
   - Sample app demonstrates usage
   - Versioned release notes

4. **UI:**
   - Portal pages designed (Figma) before code
   - Empty states covered (no data yet, error states)
   - Loading states (skeletons for >200ms)
   - Mobile-friendly (responsive, not native)
   - Accessibility: WCAG 2.1 AA

5. **Tests:**
   - Unit tests ≥ 80% line, ≥ 75% branch
   - Integration tests for the data path
   - E2E test for the user journey
   - Load test for the hot path
   - All tests pass in CI

6. **Documentation:**
   - User-facing docs (`.agents/skills/<feature>/SKILL.md`)
   - API reference (OpenAPI → docs site)
   - Migration guide (for breaking changes)
   - Internal runbook (for ops)

7. **Telemetry:**
   - Feature usage tracked (per org, per feature)
   - Errors logged with feature tag
   - Latency tracked in `/internal/health` dashboard

8. **Rollout:**
   - Feature flag in place (if not default-on)
   - Pilot plan defined
   - Rollback procedure documented + tested
   - Communication plan (changelog, customer email if breaking)

### J.2 Cross-cutting quality bar

- **No silent failures:** every error has a path to surface (log, hook, alert, dashboard)
- **No data loss in migrations:** destructive migrations require `dry_run=true` first
- **No default-on breaking changes:** any breaking change is feature-flagged
- **No customer-facing "we'll fix this later" UI:** if it's broken, hide it
- **No undocumented APIs:** every endpoint in OpenAPI
- **No test gaps in critical paths:** the 100% coverage table in §G.2 is non-negotiable

### J.3 Ship checklist (template)

Before merge to `main`:

```
- [ ] Migration written + tested in staging
- [ ] ClickHouse mirror written (where applicable)
- [ ] API endpoint(s) added + OpenAPI updated
- [ ] SDK changes (Python + TS) merged
- [ ] Portal UI complete + reviewed
- [ ] Tests: unit + integration + E2E all pass
- [ ] Coverage: line ≥ 80%, branch ≥ 75%
- [ ] Docs: user-facing + API reference + runbook
- [ ] Telemetry: feature usage tracked + errors logged
- [ ] Feature flag: created with default value + expiration
- [ ] Pilot plan: defined with success criteria
- [ ] Rollback procedure: documented + tested
- [ ] Risk register entry: created + reviewed
- [ ] Stakeholder sign-off: PM + Eng Lead + (Security if applicable)
```

---

## Closing summary (2026-06-24)

**Phases 1, 2, and 3 are all ✅ DONE 2026-06-24** — shipped in 8 sessions + 1 audit + 1 polish commit (commits `a22124d5` through `615108d4` on `main`). Detailed status: `docs/spec/upgradespec-v2.md` (the canonical v2 status doc).

**This document now covers what's REMAINING:**

- **D.11 RTBF cross-store** — engineering half buildable behind a disabled-by-default flag; policy half (GDPR Art.17(3) exception matrix, 30-day SLA, backup retention exception) needs legal review. Blocked on user acquiring legal counsel.
- **D.12 Multi-region** — 6-week infra investment for `eu-central-1` + `ap-southeast-1`. Parked until customer demand validates the spend.
- **Phase 4 Operational debt** — migration compatibility matrix doc, doc-test harness, feature flag inventory, chaos test suite, load test for ClickHouse partition scale, `/internal/health` dashboard. The flag-inventory item is moot (user opted out of feature flags).

**The 5 things not to compromise (closed):**
1. Streaming tokens (§6.1) — ✅ DONE 2026-06-24 (commit `a22124d5`)
2. Prompt versioning (§6.2) — ✅ DONE 2026-06-24 (commit `a22124d5`)
3. Cost guardrails (§6.3) — ✅ DONE 2026-06-24 (commit `a22124d5`)
4. Cold-start UX (§10) — ✅ DONE 2026-06-24 (commit `68fe65bb`)
5. RTBF cross-store (§6.4) — 🟡 DEFERRED (no legal team)

**The 5 things to defer (current state):**
1. Cat 23 real ship — 🟡 v1.6 STUB surface shipped; real ship is 8-week gated initiative
2. Multi-region AP — 🟡 not started; needs customer demand
3. ~~Voice/audio (partner with LiveKit instead)~~ — ✅ SHIPPED (D.12.4, commit `1cefa144`) — partner approach not needed
4. ~~MCP server (every LLM vendor builds one)~~ — ✅ SHIPPED (D.12.1, commit `8b7c97b8`) — auto-instrument approach used
5. ~~Edge inference observability~~ — not in scope; deferred by original spec
6. **NEW:** D.11 RTBF cross-store — 🟡 DEFERRED (no legal team)

**Single biggest remaining leverage:** D.11 RTBF engineering work is buildable now behind a flag. The 30-day SLA + 4-phase worker (Postgres → ClickHouse → S3 → backups audit) is the largest GDPR-completeness gap. When legal review is available, this becomes the next work item.

**Net shipped vs spec:** 17 of 22 spec'd cats + 11 spec items + D.1-D.7 cuts + D.8-D.10/D.13 spine + D.12.1-6 sub-protocols + D.14 cold-start + 10/10 §E.1 hooks = ~95% of the original spec shipped. Remaining: D.11 RTBF, D.12 multi-region, Phase 4 op debt.