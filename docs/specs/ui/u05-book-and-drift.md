# U05: The Book & Behavioral Drift

| Field | Value |
|---|---|
| **Spec ID** | U05 |
| **Priority** | P0 |
| **Effort** | L |
| **Eden status** | PARTIAL — book is markdown-in-pre; drift cards with possible mock currents |
| **Clone targets** | Bento The Book + drift pinpoint |
| **Dependencies** | F40, F42, F41, U02, U12, U18 |
| **Routes** | `/agents/[id]/book`, `/agents/[id]/drift`; Improve nav shortcuts |
| **Roadmap** | Feature Wave 4; density Wave 12 |

---

## 1. Summary

Two agent-scoped surfaces: **The Book** (living plain-language memory) and **Drift** (what shifted). Both must be trustworthy — no mock histograms in production, real markdown, citations, and drill-down to traces.

---

## 2. The Book — layout

```
┌ Versions ▾ · Diff vs previous · Regenerate · Injection ON/OFF · Max tokens ┐
├ Chapters (sticky)     │ Rendered markdown (prose, not <pre>)                 │
│ · Recent failures     │ headings + citation chips → Issues / Artifacts /     │
│ · Proven fixes        │ Traces                                               │
│ · Tool/MCP gotchas    │                                                      │
│ · Do-not-repeat       │                                                      │
├───────────────────────┴──────────────────────────────────────────────────────┤
│ Foot: generated_at · source counts · token estimate · F41 gate status          │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Interactions
| Action | Behavior |
|---|---|
| Version picker | Load historical `agent_books.version` |
| Diff | Side-by-side or unified diff of content_md |
| Regenerate | Queue LLM job; progress toast; disable double-click |
| Injection toggle | Writes `agent_book_config.enabled` |
| Max tokens | Slider 500–2000; gateway respects cap |
| Citation chip | Opens Issue / Artifact / Trace (U01 panel) |
| Publish | If injection content changes → F41 confirm or EvidenceGate |

### Empty state
> "The Book is living memory for this agent — failures, fixes, and gotchas in plain language."
> CTA: Resolve an issue · Promote an artifact

---

## 3. Drift — layout

```
┌ Window: 24h vs baseline 7d · Compute now · Slack digest subscribe ───────────┐
├ Summary: plain-English top 3 shifts                                           │
├ Dimension cards (grid):                                                       │
│  tool_distribution │ model_mix │ prompt_version_mix │ avg_steps │            │
│  cost_per_trace │ stumble_rate │ mcp_error_rate                               │
│  Each: PSI · Δ% · histogram baseline vs current · flag border if PSI>θ      │
│  [Show example traces] → U01 with filters                                     │
└───────────────────────────────────────────────────────────────────────────────┘
```

### Rules
- **Never show `_mock_currents` in production** — empty state if baselines missing
- Likely-cause chips: prompt version, model swap, traffic mix (correlate deploys)
- Fleet badge when any agent PSI > threshold (N05)

### Empty state
> "No baseline yet. Eden needs enough production traces to learn normal behavior."
> CTA: Compute when data sufficient · Open Traces

---

## 4. Keyboard

Book: `v` versions, `d` diff, `r` regenerate (confirm).  
Drift: `c` compute, `1–7` focus dimension, `Enter` show traces.

---

## 5. Acceptance criteria

- [ ] Book renders markdown with version diff + citations
- [ ] Drift charts use live histograms only
- [ ] Drill-down opens Traces with filters
- [ ] Both linked from Improve nav + agent detail
- [ ] Injection toggle + token budget persist
- [ ] F41 gate on Book publish when injection enabled

---

## 6. Performance

Book get latest <200ms (cached); drift report get <400ms; regenerate/compute async.
