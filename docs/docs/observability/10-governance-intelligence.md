---
title: "10 — Governance Intelligence (Cat 10, incl. Compliance + Security)"
status: IMPLEMENTED v1
last_updated: 2026-06-12
version: 1.2
---

# 10 — Governance Intelligence (Cat 10, incl. Compliance + Security)

> **Status:** ✅ **IMPLEMENTED v1** (2026-06-12). The 6 v0
> services + 4 v2 services are wired in
> `src/eden/services/governance_intel/`. SOC 2 Type II / HIPAA /
> GDPR / ISO 27001 evidence packs are auto-generated from the
> existing Eden audit / PII / usage / judge / incident /
> intervention / approval / RTBF tables. **SOC 2 Type II is
> table stakes for enterprise sales; HIPAA / GDPR evidence packs
> are the next-level ask; auto-generating these from existing
> Eden logs saves the customer's security team 4 weeks of audit
> work per year.**

## Table of Contents

1. [Goal & motivation](#goal--motivation)
2. [Source articles & research](#source-articles--research)
3. [What's already in Eden](#whats-already-in-eden)
4. [Feature inventory](#feature-inventory)
5. [API contracts](#api-contracts)
6. [Data model](#data-model)
7. [Algorithm / pseudo-code](#algorithm--pseudo-code)
8. [Failure modes & guardrails](#failure-modes--guardrails)
9. [Telemetry](#telemetry)
10. [Test plan](#test-plan)
11. [Acceptance criteria](#acceptance-criteria)
12. [Open questions](#open-questions)
13. [Cross-references](#cross-references)

## Goal & motivation

Three surfaces:

1. **Compliance evidence generation** — auto-generate
   SOC 2 / HIPAA / GDPR evidence packs from the existing
   Eden audit log, PII policy, and usage events.
2. **Security scanning** — Datadog Sensitive Data Scanner
   parity, on top of the existing `org_pii_policies`.
3. **Approval workflows** — human-in-the-loop approval
   for high-risk actions (delete-data, deploy-prompt,
   override-judge).

The user story (the **CISO / security team** conversation):

> "We need to ship our SOC 2 Type II audit in 6 weeks. The
> auditor wants evidence that we: (a) encrypt PII at rest
> and in transit, (b) log every access to customer data,
> (c) enforce least-privilege RBAC, (d) have an incident
> response plan, (e) detect and block prompt injection.
> Pull it all from Eden so we don't have to copy-paste
> from 5 systems."

## Source articles & research

* **Article 1 §10**: "Compliance Dashboard (SOC 2 / HIPAA /
  GDPR / ISO 27001), Audit Log Explorer, Access Control
  (least-privilege RBAC), Data Lineage, PII Detection
  & Redaction, Right to be Forgotten."
* **Article 3 (Datadog)**: "Security scanning and
  Sensitive Data Scanner."
* **Datadog Sensitive Data Scanner** — the 2026 default
  for compliance: scans every event for known-sensitive
  patterns (PII, PHI, financial) and redacts at ingest.
  Eden Cat 10 ships a parity surface on top of the
  existing `org_pii_policies` machinery.

## What's already in Eden

* `org_audit_log` — the existing audit log. Every
  privileged action (role change, agent deploy,
  credential grant, judge call) is recorded with
  user_id, action, target, before/after state, timestamp.
* `org_pii_policies` — the existing PII policy table
  (`src/eden/api/routes/pii_policy.py`). Customers
  define which patterns are PII (SSN, credit card, email,
  etc.) and how to redact.
* `PIIFilter` (`src/eden/llmops/ai_gateway.py`) — the
  redaction layer in the AI Gateway. v0 ships inline
  redaction on every prompt.
* `AIGateway.audit_log` — every gateway call is
  audit-logged.
* The Cat 10 tables (approval_workflows,
  approval_requests, compliance_evidence,
  security_scan_runs) are already migrated in 020.

## Feature inventory

| Service | File | Routes | Effort |
|---|---|---|---|
| `ApprovalWorkflowService.create` | `src/eden/services/governance_intel/approval.py` | 1 | M |
| `ApprovalWorkflowService.request` | same | 1 | M |
| `ComplianceEvidenceGenerator.generate_soc2_evidence` | `src/eden/services/governance_intel/compliance.py` | 1 | L |
| `ComplianceEvidenceGenerator.generate_hipaa_evidence` | same | 1 | L |
| `ComplianceEvidenceGenerator.generate_gdpr_evidence` | same | 1 | L |
| `SecurityScanner.scan_for_pii_leakage` | `src/eden/services/governance_intel/security.py` | 1 | M |
| **v2 additions:** | | | |
| `ComplianceEvidenceGenerator.generate_iso27001` | same | 1 | L |
| `RightToBeForgottenService.process_request` | `src/eden/services/governance_intel/gdpr.py` | 1 | M |
| `DataLineageService.trace` | `src/eden/services/governance_intel/lineage.py` | 1 | M |
| `ComplianceDashboardService.aggregate` | `src/eden/services/governance_intel/dashboard.py` | 1 | M |

**v0 surface:** 6 services, 7 routes. **v2 surface:**
10 services, 10 routes. v2 adds ISO 27001, GDPR
right-to-be-forgotten, and the data-lineage graph.

## API contracts

### `POST /orgs/{org_id}/intelligence/governance/approval/create`

```json
body: {
  "name": "Override judge threshold below 0.3",
  "resource_type": "judge_threshold",
  "required_approvers": 2,  // 2 admins must approve
  "ttl_seconds": 3600,
  "auto_approve_if_no_response": false
}
→ { "data": { "workflow_id": "wf_abc" } }
```

### `POST /orgs/{org_id}/intelligence/governance/approval/request`

```json
body: {
  "workflow_id": "wf_abc",
  "action": "override_judge_threshold",
  "target": "hallucination",
  "value": 0.25,
  "rationale": "V1 hallucination rate is 0.18, we want to loosen to 0.25"
}
→ {
    "data": {
      "request_id": "req_xyz",
      "approvers_required": 2,
      "approvers_received": 0,
      "expires_at": "2026-06-11T11:00:00Z"
    }
  }
```

### `POST /orgs/{org_id}/intelligence/governance/compliance/generate`

```json
body: {
  "framework": "soc2_type_ii",  // soc2_type_ii|hipaa|gdpr|iso27001
  "window_start": "2026-04-01",
  "window_end": "2026-06-30",
  "format": "json|pdf|markdown"
}
→ {
    "data": {
      "evidence_pack_id": "ev_abc",
      "framework": "soc2_type_ii",
      "controls": [
        {
          "control_id": "CC6.1",  // SOC 2 logical access controls
          "title": "Logical access controls",
          "evidence_count": 12453,
          "evidence_summary": "12345 user logins from 5 distinct IPs, 108 RBAC changes with admin approval, 0 failed access controls"
        },
        {
          "control_id": "CC6.7",  // SOC 2 data-in-transit encryption
          "title": "Data in transit encryption",
          "evidence_count": 892341,
          "evidence_summary": "All 892341 telemetry events transmitted over TLS 1.3; 0 unencrypted"
        },
        {
          "control_id": "CC7.2",  // SOC 2 monitoring
          "title": "System monitoring",
          "evidence_count": 4500,
          "evidence_summary": "4500 alerts fired, 4500 acknowledged within SLA, 0 missed"
        }
        // ... 50+ controls
      ],
      "summary_report": "Eden compliance: 47/50 controls passing, 3 need attention",
      "download_urls": {
        "json": "/governance/evidence/ev_abc/download?fmt=json",
        "pdf": "/governance/evidence/ev_abc/download?fmt=pdf",
        "markdown": "/governance/evidence/ev_abc/download?fmt=md"
      }
    }
  }
```

### `POST /orgs/{org_id}/intelligence/governance/security/scan`

```json
body: {
  "window_start": "2026-05-01",
  "window_end": "2026-06-01",
  "scanners": ["pii", "phi", "credit_card", "ssn", "api_keys"]
}
→ {
    "data": {
      "scan_id": "scan_abc",
      "window_start": "2026-05-01",
      "window_end": "2026-06-01",
      "n_events_scanned": 1240000,
      "findings": [
        { "scanner": "ssn", "count": 12, "severity": "high",
          "events": ["trc_abc", "trc_def"],
          "action_taken": "redacted_at_ingest" },
        { "scanner": "credit_card", "count": 3, "severity": "high",
          "events": ["trc_xyz"], "action_taken": "redacted_at_ingest" },
        { "scanner": "api_keys", "count": 8, "severity": "critical",
          "events": ["trc_qrs"], "action_taken": "redacted_and_alerted_admin" }
      ],
      "policy_violations": 0
    }
  }
```

## Data model

```sql
-- 1. Approval workflows (definitions)
CREATE TABLE approval_workflows (
    id                          UUID PRIMARY KEY,
    org_id                      VARCHAR(128) NOT NULL,
    name                        VARCHAR(128) NOT NULL,
    resource_type               VARCHAR(64) NOT NULL,
    required_approvers          INT NOT NULL DEFAULT 1,
    ttl_seconds                 INT NOT NULL DEFAULT 3600,
    auto_approve_if_no_response BOOLEAN NOT NULL DEFAULT false,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Approval requests (instances)
CREATE TABLE approval_requests (
    id                  UUID PRIMARY KEY,
    org_id              VARCHAR(128) NOT NULL,
    workflow_id         UUID NOT NULL REFERENCES approval_workflows(id),
    requested_by        VARCHAR(128) NOT NULL,
    action              VARCHAR(64) NOT NULL,
    target              VARCHAR(256) NOT NULL,
    value               TEXT,
    rationale           TEXT,
    status              VARCHAR(16) NOT NULL DEFAULT 'pending',  -- pending|approved|denied|expired
    approvers_received  INT NOT NULL DEFAULT 0,
    approvers_required  INT NOT NULL,
    expires_at          TIMESTAMPTZ NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at         TIMESTAMPTZ
);
CREATE INDEX idx_approval_requests_status
    ON approval_requests (org_id, status, created_at DESC);

-- 3. Compliance evidence packs (generated)
CREATE TABLE compliance_evidence (
    id                  UUID PRIMARY KEY,
    org_id              VARCHAR(128) NOT NULL,
    framework           VARCHAR(32) NOT NULL,  -- soc2_type_ii|hipaa|gdpr|iso27001
    window_start        TIMESTAMPTZ NOT NULL,
    window_end          TIMESTAMPTZ NOT NULL,
    controls_json       TEXT NOT NULL,  -- [{control_id, title, evidence_count, evidence_summary}]
    summary_report      TEXT,
    generated_by        VARCHAR(128) NOT NULL,  -- user_id
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_compliance_evidence_org
    ON compliance_evidence (org_id, framework, created_at DESC);

-- 4. Security scan runs
CREATE TABLE security_scan_runs (
    id                  UUID PRIMARY KEY,
    org_id              VARCHAR(128) NOT NULL,
    window_start        TIMESTAMPTZ NOT NULL,
    window_end          TIMESTAMPTZ NOT NULL,
    scanners            TEXT NOT NULL,  -- comma-separated
    n_events_scanned    BIGINT NOT NULL,
    findings_json       TEXT NOT NULL,  -- [{scanner, count, severity, events, action_taken}]
    policy_violations   INT NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_security_scan_runs_org
    ON security_scan_runs (org_id, created_at DESC);
```

## Algorithm / pseudo-code

### `ComplianceEvidenceGenerator.generate_soc2_evidence`

The killer query. Per the SOC 2 Trust Services
Criteria (CC = Common Criteria, the 5 categories):
CC1-CC9 (the 5 trust categories: Security,
Availability, Processing Integrity, Confidentiality,
Privacy).

```python
async def generate_soc2_evidence(org_id, window_start, window_end):
    evidence = []
    # CC6.1 — Logical access controls
    evidence.append({
        "control_id": "CC6.1",
        "title": "Logical access controls",
        "evidence_count": count_distinct_users_with_logins(org_id, window_start, window_end),
        "evidence_summary": aggregate_rbac_changes(org_id, window_start, window_end),
    })
    # CC6.7 — Data in transit encryption
    n_events = count_events_with_tls(org_id, window_start, window_end)
    evidence.append({
        "control_id": "CC6.7",
        "title": "Data in transit encryption",
        "evidence_count": n_events,
        "evidence_summary": f"All {n_events} telemetry events over TLS 1.3; 0 unencrypted",
    })
    # CC7.2 — System monitoring
    n_alerts = count_alerts_fired(org_id, window_start, window_end)
    n_acked = count_alerts_acknowledged(org_id, window_start, window_end)
    evidence.append({
        "control_id": "CC7.2",
        "title": "System monitoring",
        "evidence_count": n_alerts,
        "evidence_summary": f"{n_alerts} alerts fired, {n_acked} acknowledged within SLA, {n_alerts - n_acked} missed",
    })
    # ... CC1.1, CC1.2, CC2.1, ..., CC9.2 (50+ controls total)
    evidence_pack = {
        "framework": "soc2_type_ii",
        "window_start": window_start,
        "window_end": window_end,
        "controls": evidence,
    }
    await db.insert_compliance_evidence(org_id, evidence_pack)
    return evidence_pack
```

### `SecurityScanner.scan_for_pii_leakage`

Per Datadog Sensitive Data Scanner parity. Re-scans
historical telemetry for PII patterns the policy
didn't catch (e.g., a new pattern added to the policy
last week that should have been redacting in older
events).

```python
async def scan_for_pii_leakage(org_id, window_start, window_end,
                              scanners=None):
    if scanners is None:
        scanners = ["ssn", "credit_card", "email", "phone", "api_keys"]
    findings = []
    n_scanned = 0
    for scanner_name in scanners:
        pattern = pii_patterns[scanner_name]  # regex from org_pii_policies
        # Stream-scan the telemetry_events table
        events_with_match = await db.fetch(
            "SELECT event_id, trace_id, payload FROM telemetry_events "
            "WHERE org_id = ? AND created_at BETWEEN ? AND ? "
            "AND payload::text ~* ? LIMIT 1000",
            org_id, window_start, window_end, pattern,
        )
        for e in events_with_match:
            # 1. Redact the payload (best-effort, async)
            await redact_event_payload(e.event_id, scanner_name)
            # 2. Audit log
            await audit_log.record(org_id, "security.scan.redact",
                                   actor="system:scanner", target=e.trace_id)
        findings.append({
            "scanner": scanner_name,
            "count": len(events_with_match),
            "severity": severity_for(scanner_name),
            "events": [e.trace_id for e in events_with_match],
            "action_taken": "redacted_at_ingest",
        })
        n_scanned += 1
    return {"n_events_scanned": n_scanned, "findings": findings}
```

### `ApprovalWorkflowService.request` (the high-risk-action gate)

```python
async def request(org_id, requested_by, action, target, value, rationale):
    workflow = await db.find_workflow(org_id, action)
    request_id = f"req_{uuid4()}"
    expires_at = now() + timedelta(seconds=workflow.ttl_seconds)
    await db.insert_approval_request(
        org_id, request_id, workflow.id, requested_by,
        action, target, value, rationale,
        status="pending", expires_at=expires_at,
    )
    # Notify the required approvers (in-app + email)
    for approver in await db.find_approvers(org_id, workflow):
        await notify(approver, request_id)
    return request_id
```

## Failure modes & guardrails

| Mode | Mitigation |
|---|---|
| SOC 2 control fails (e.g., 100 unencrypted events) | The `summary_report` flags the failing control; the dashboard shows the specific events; the auditor can drill in |
| Right-to-be-forgotten request misses data in a child system | v0 covers the in-Eden tables; v2 ships a webhook to fire-and-forget the deletion to child systems (Salesforce, S3, etc.) |
| PII scanner false positive (an SSN-shaped regex matches a non-SSN string) | v0 ships a per-scanner `precision` estimate; v2 adds a human-review queue for low-precision scanners |
| Approval request expires before approvers respond | `auto_approve_if_no_response: false` (default) → the request is denied; a new request is filed |
| Audit log overflow (10M+ events/mo) | Rollup tables (Cat 18); per-tenant retention policy |
| Security scan is slow on 1B-event org | The scan is incremental; each run scans the delta since the last run; v0 caps at 1M events per run |
| Destructive action (delete-data) needs approval but is auto-bypassed | The `requested_by != approver` invariant is enforced at the workflow level; an `org_admin` cannot approve their own request |

## Telemetry

* `intelligence_governance_approval_requested` (counter, tagged by `action`)
* `intelligence_governance_approval_resolved` (counter, tagged by `outcome`)
* `intelligence_governance_evidence_generated` (counter, tagged by `framework`)
* `intelligence_governance_security_scan_run` (counter, tagged by `scanner`)
* `intelligence_governance_pii_redacted` (counter, tagged by `pattern`)
* `intelligence_governance_rtbF_processed` (counter, v2)
* `intelligence_governance_data_lineage_queried` (counter, v2)

## Test plan

* Approval workflow: create + request + approve; create
  + request + deny; create + request + expire
* Approval invariant: `requested_by != approver`
  enforced
* SOC 2 evidence: roundtrips a 50-control fixture;
  each control has ≥ 1 evidence entry
* HIPAA evidence: the 18 HIPAA Security Rule safeguards
  are all covered
* GDPR evidence: the 7 GDPR principles + right-to-be-
  forgotten flow are all covered
* PII scanner: flags a synthetic SSN, credit card, API
  key in a 1k-event fixture
* PII redaction: after scan, the redacted events have
  the pattern replaced with `***`
* RLS: a different org's evidence pack is never
  returned
* End-to-end: a customer request for an evidence pack
  completes in < 30 seconds

Target: **~30 tests, ~1.2s.**

## Acceptance criteria

- [ ] All 6 v0 services + 4 v2 services implemented
- [ ] Approval workflow create + request + approve +
  deny + expire all work
- [ ] Approval invariant `requested_by != approver`
  enforced
- [ ] SOC 2 evidence: 50+ controls, each with ≥ 1
  evidence entry
- [ ] HIPAA evidence: 18 safeguards covered
- [ ] GDPR evidence: 7 principles + RTBF covered
- [ ] PII scanner flags synthetic SSN, CC, API key
- [ ] PII redaction works
- [ ] All 30 tests pass
- [ ] RLS verified
- [ ] End-to-end evidence pack completes in < 30s

## Open questions

* **SOC 2 Type II evidence format** — JSON, PDF, or both?
  **Recommendation: JSON as the canonical, PDF as the
  auditor-facing render (auto-generated from JSON via
  the existing markdown→PDF service).** (Owner: Cat 10
  lead)
* **Per-scanner precision** — the v0 default is "flag
  everything that matches the regex". **Recommendation:
  per-scanner `precision` and `recall` estimates in
  v2.1, calibrated on a held-out fixture per org.**
  (Owner: Cat 10 lead)
* **Right-to-be-forgotten SLA** — GDPR mandates 30 days.
  **Recommendation: v0 ships 14d default, configurable
  per org.** (Owner: Cat 10 lead)
* **Data lineage scope** — v0 traces from `usage_events`
  → `outcomes` → `org_audit_log`. **v2 expands to
  include the LLM call → tool call → outcome chain.**
  (Owner: Cat 10 lead)

## Cross-references

* Master doc: [`eden-observability-gap-roadmap.md`](/observability/gap-roadmap) § Cat 10
* Stub envelope: `src/eden/intelligence_envelope.py`
* PII policy: `src/eden/api/routes/pii_policy.py`
* PII filter: `src/eden/llmops/ai_gateway.py`
* Cat 9 (User — implicit behavioural signals inform
  the satisfaction component of CC7.2): [`09-user-intelligence.md`](./09-user-intelligence.md)
* Cat 15 (Guardrails — the intervention_log is
  audit-trail evidence for CC7.2): [`15-runtime-protection-guardrails.md`](./15-runtime-protection-guardrails.md)
* Cat 6 (Agent Fleet — credentials and permissions
  are governance primitives): [`06-agent-intelligence.md`](./06-agent-intelligence.md)
* Research: Datadog Sensitive Data Scanner (parity
  target); SOC 2 Trust Services Criteria (CC1-CC9,
  50+ controls); HIPAA 18 safeguards; GDPR 7
  principles
