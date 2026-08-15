# U08: Saved Views & Filter Search Bar

| Field | Value |
|---|---|
| **Spec ID** | U08 |
| **Priority** | P0 |
| **Effort** | M |
| **Eden status** | MISSING portal — Phase N searches unwired |
| **Clone targets** | Laminar table-views; Langfuse filter bar; Braintrust Views |
| **Dependencies** | F58, U00, U18 |
| **Applies to** | traces, spans, sessions, issues, alerts, datasets, experiments, artifacts, signals, labeling |
| **Roadmap** | Wave 3; Wave 11 |

---

## 1. Filter search bar (Langfuse-class)

### Query language v1
```
latency:>2
agent:support
status:error
scores.accuracy:<0.8
tag:prod
user:usr_123
metadata.campaign:summer
text:"command not found"
```

- Autocomplete fields + ops + enums
- Chips under bar; click to edit
- URL: `?q=` and/or `?filter=` JSON AST
- Modes: Basic chips | Query string | SQL/EQL
- Undo/redo filter edits
- "Create alert from filters" → F81/U04
- Copilot NL→query (U16) optional

### Time range
Presets 15m–30d + custom; Live toggle when N11 supported.

---

## 2. Saved views (Laminar)

Persists: filters, search, sort, columns, density, default time range.

```
Views ▾  (amber when dirty)
  ★ Default
  ── Personal ──
  ── Project ──
  [Save] [Save as…] [Discard]
```

Defaults hierarchy: personal → project → org → built-in.  
Admins publish project views.

### Built-in seeds
Traces: Default, Errors, High cost, Unreviewed  
Issues: Open, P0, Unassigned  
Alerts: Real unacked, Benign 24h  

---

## 3. API (F58)

```
CRUD /orgs/{org}/views?resource=traces
POST /orgs/{org}/views/{id}/set-default
```

Migrate Phase N saved searches → views.

---

## 4. Acceptance criteria

- [ ] Query bar on Traces with autocomplete
- [ ] Views dirty/save/discard
- [ ] Project views shared
- [ ] URL round-trip
- [ ] Create alert from filters

---

## 5. Performance

Views list Redis 60s; filter compile <50ms; $0 LLM on critical path.
