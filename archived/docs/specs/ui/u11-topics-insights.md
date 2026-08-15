# U11: Topics / Insights Explorer

| Field | Value |
|---|---|
| **Spec ID** | U11 |
| **Priority** | P2 |
| **Effort** | XL |
| **Eden status** | PARTIAL — insights exist; no Topics product UI |
| **Clone targets** | Braintrust Topics; Galileo Insights |
| **Dependencies** | F65, F06, U01, U18 |
| **Route** | `/insights/topics` (or promoted `/insights`) |
| **Roadmap** | Wave 8; polish Wave 13 |

---

## 1. Layout

```
┌ Facets: Task | Sentiment | Issues | Custom · Generate · Settings ───────────┐
├ Scatter / list toggle · time range                                            │
├ Left: ranked clusters (share %, keywords) │ Right: chart + samples            │
│ Click cluster → side panel summaries · Open traces · Act ▾                    │
└ Act: Create dataset · Online rule · Assign review · Artifact candidate ───────┘
```

---

## 2. Interactions

- Generate / Save pipeline; classify incoming toggle
- Hover scatter → summary; click → panel
- Filter Logs/Traces by topic classification
- Digest settings (Slack) if F71/F47 available

---

## 3. Empty state

> "Topics appear after enough production traffic. Generate a first run when ready."

---

## 4. Acceptance criteria

- [ ] Built-in Task/Sentiment/Issues facets
- [ ] Cluster list + chart + drill to U01
- [ ] Act menu creates dataset from cluster filter
- [ ] Hidden from core nav until F65 ready (Advanced OK)

---

## 5. Performance

Snapshot load <1s; scatter virtualized for large N; clustering async.
