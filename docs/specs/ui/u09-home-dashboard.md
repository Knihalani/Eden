# U09: Home Dashboard

| Field | Value |
|---|---|
| **Spec ID** | U09 |
| **Priority** | P1 |
| **Effort** | M |
| **Eden status** | PARTIAL — static KPI cards |
| **Clone targets** | Langfuse Home; Helicone KPI deltas; Laminar/HoneyHive dashboards |
| **Dependencies** | F57, F60, U00, U18, F82 |
| **Route** | `/dashboard` |
| **Roadmap** | Wave 6 feature; Wave 12 density |

---

## 1. Summary

Editable first screen after login: widgets for volume, errors, cost Δ, open issues, shadow artifacts, drift flags, latency. Click-through to filtered resources. Role-aware defaults (on-call vs builder).

---

## 2. Layout

```
┌ PageHeader: Home · Edit layout · Time range · Live ─────────────────────────┐
├ Widget grid (drag-resize, 12-col)                                            │
│  [Big number] [Big number] [Big number] [Big number]                         │
│  [Time series ──────────────] [Top list ─────]                               │
│  [Issues needs-you] [Artifacts candidates] [Drift flags]                     │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Default widgets
Traces volume, error rate, cost Δ vs prior period (Helicone-style), p95 latency, open P0 issues, shadow artifacts ready, agents with drift flags.

### Edit mode
- + Widget: preset (traces/spans/scores/cost/issues) or Custom EQL/SQL (F57)
- Drag resize; save personal layout; reset to org default
- Brush zoom on time series → open Traces with time filter
- Click datapoint → deep link

---

## 3. Empty / first-run

If no traces: onboarding CTA (connect SDK / gateway) — Gap 4.8 narrative.  
If traces but empty widgets: "Waiting for aggregates" skeleton.

---

## 4. Acceptance criteria

- [ ] Editable layout persists per user
- [ ] KPI tiles show Δ vs prior period
- [ ] Click-through to Traces/Issues/Artifacts works
- [ ] Custom widget from EQL/SQL (F57)
- [ ] Meets F82 page interactive budget

---

## 5. Performance

Widget queries parallel; cache 60s; no LLM on load. p95 interactive <800ms.
