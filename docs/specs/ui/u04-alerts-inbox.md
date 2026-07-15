# U04: Alerts Inbox (NL + real/benign triage)

| Field | Value |
|---|---|
| **Spec ID** | U04 |
| **Priority** | P0 |
| **Effort** | L |
| **Eden status** | PARTIAL — card inbox + ack; rules read-only; no NL; no triage verdict |
| **Clone targets** | Bento NL alerts + incident judge; Braintrust create-from-filters; Laminar signal alerts |
| **Dependencies** | F81, F47, U00, U01, `/incidents` |
| **Route** | `/alerts` |

---

## 1. Summary

Operator writes alerts in English (or from current filters). Fires group into incidents. An SLM judge marks each **real / benign / duplicate** so on-call only wakes for real drift.

---

## 2. Layout

```
┌ KPI tiles: Open real · Benign (24h) · Dup suppressed · MTTA ────────────┐
├ Tabs: Inbox | Rules | Channels                                          │
├ Filters: severity · verdict · ack · agent · source                      │
├ Dual mode toggle: Cards | Table (U00)                                   │
├ List ──────────────────────────────┬ Detail / Incident link ────────────┤
│ severity · title · verdict · time  │ NL explanation · traces · actions  │
└────────────────────────────────────┴────────────────────────────────────┘
```

---

## 3. Inbox row / card

| Field | UI |
|---|---|
| Severity | P0–P3 color bar |
| Title | Human summary |
| Verdict | `real_incident` (red) · `benign` (gray) · `duplicate` (blue) · `pending` |
| Source | Rule name / Signal / Drift / Cost |
| Group | “Part of Incident INC-…” link |
| Actions | Ack · Silence 1h/24h · Mark benign · Escalate · Open traces |

Only **real** + unacked count toward badge / Slack page (F47).

---

## 4. Rules tab — NL authoring

### Create rule drawer
1. **English** textarea: e.g. “Wake me if support agent cost per run exceeds $0.30 for 15 minutes”
2. **Compile** → EQL/SQL preview (editable)
3. Window, severity, sample/min volume
4. Channels: in-app, Slack, email, webhook
5. Triage: “Run real/benign judge” toggle (default on)

### From Traces
FilterBar → **Create alert from filters** pre-fills compiled query (Braintrust pattern).

### Rule list
Name · status · last fired · precision (real/(real+benign)) · edit/disable

---

## 5. Triage UX (F81)

Detail shows judge rationale:
```
Verdict: BENIGN (0.82)
Reason: Traffic spike matches marketing campaign tag campaign=summer_sale;
        stumble rate unchanged vs 7d baseline.
[ Agree ] [ Override → Real ] [ Open similar]
```

Human override trains feedback for judge (store on `alert_events`).

---

## 6. Channels tab

Un-stub F47: Slack workspace connect, channel picker, email list, webhook URL + test. Strikethrough placeholders removed.

---

## 7. Acceptance criteria

- [ ] NL → compile → save rule works end-to-end
- [ ] Inbox shows triage_verdict; default filter hides benign/dup
- [ ] Create alert from Traces filters
- [ ] Channels configurable in UI
- [ ] Link to incident cluster when grouped
- [ ] Override + feedback persisted

---

## 8. Performance

Inbox poll ≤15s or SSE; judge async <30s p95 after fire; compile NL <3s p95 (SLM).
