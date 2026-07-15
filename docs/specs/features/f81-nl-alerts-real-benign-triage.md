# F81: NL Alerts + Real/Benign Triage

| Field | Value |
|---|---|
| **Feature ID** | F81 |
| **Priority** | P0 |
| **Effort** | M |
| **Eden status** | **SHIPPED v0** — NL compile + AlertTriageJudge + triage columns |
| **Competitive source** | BentoLabs AI (Gap 4.5); Braintrust alerts-from-filters; Laminar signal alerts |
| **UI spec** | [U04](../ui/u04-alerts-inbox.md) |
| **Dependencies** | EQL DSL, F47, incidents, F42 drift (optional) |
| **Legacy** | `competitor-gaps/04-bentolabs.md` §4.5 |

---

## 1. Summary

Write alerts in English → compile to EQL/SQL → fire → **AlertTriageJudge** classifies `real_incident` | `benign` | `duplicate` → only real pages on-call. Group fires into incidents.

---

## 2. Eden current state

| Component | Status |
|---|---|
| `/alerts` inbox | SHIPPED ack/list + verdict filter |
| EQL alert compile | SHIPPED (`eden.alerts.compiler`) |
| Infra alerts | Separate system |
| `AlertTriageJudge` | **SHIPPED** (`eden.alerts.triage_judge`) |
| `triage_verdict` column | **SHIPPED** (migration 098) |

---

## 3. Target behavior

1. NL rule → LLM/SLM compile → editable EQL preview → save
2. On fire: create `alert_event`; enqueue triage
3. Judge uses: rule context, metrics window, recent deploys, open issues, tags
4. Verdict stored; Slack/page only if `real_incident` (and not silenced)
5. Duplicate links to open issue/incident
6. Human override feeds few-shot feedback table
7. Create-from-filters on Traces (U08)

---

## 4. Architecture

```
NL text → AlertCompiler (SLM) → EQL AST → eql_alert_rules
Fire → alert_events → AlertTriageJudge (SLM) → triage_verdict
      → IncidentGrouper → /incidents link
      → Notifier (F47) if real
```

---

## 5. Data model

```sql
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS triage_verdict TEXT;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS triage_reason TEXT;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS triage_confidence NUMERIC;
ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS incident_id UUID;

CREATE TABLE alert_triage_feedback (
  id UUID PRIMARY KEY,
  alert_event_id UUID NOT NULL,
  human_verdict TEXT NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE nl_alert_rules (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  name TEXT NOT NULL,
  nl_text TEXT NOT NULL,
  compiled_eql TEXT NOT NULL,
  triage_enabled BOOLEAN DEFAULT true,
  channels JSONB,
  enabled BOOLEAN DEFAULT true
);
```

---

## 6. API

```
POST /orgs/{org}/alerts/compile          { nl_text } → { eql, warnings }
CRUD /orgs/{org}/nl-alert-rules
POST /orgs/{org}/alerts/{id}/override    { verdict }
GET  /orgs/{org}/alerts?verdict=real_incident
```

---

## 7. Acceptance criteria

- [ ] English rule compiles and fires on synthetic metric breach
- [ ] Benign marketing spike suppressed (fixture test)
- [ ] Duplicate links to existing issue
- [ ] Override persisted; improves future few-shot (offline eval)
- [ ] Channels configurable (U04)
- [ ] Create alert from Traces filters

---

## 8. Performance & cost

| Operation | p50 | p95 |
|---|---|---|
| Compile NL | <1.5s | <3s |
| Triage judge | <2s | <8s |
| Inbox query | <100ms | <400ms |

- SLM tier for compile+triage (not Sonnet)
- Budget: triage skipped if org alert storm >N/min → mark `pending` + sample
- Metrics: `eden_alert_triage_verdict_total{verdict=}`, `eden_alert_compile_seconds`
