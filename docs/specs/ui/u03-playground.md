# U03: Playground (Braintrust / Arize / LangSmith-class)

| Field | Value |
|---|---|
| **Spec ID** | U03 |
| **Priority** | P0 |
| **Effort** | XL |
| **Eden status** | MISSING route — `/prompts` list-only; `/debugger` ≠ playground; `/studio` = metrics |
| **Clone targets** | Braintrust Playgrounds; Arize Prompt Playground; LangSmith; Laminar playgrounds |
| **Dependencies** | F49, F53, F51, U01 (open from span), U10 |
| **Route** | `/playgrounds`, `/playgrounds/[id]` |

---

## 1. Summary

Browser environment to iterate prompts/models/tools on **production-derived dataset rows** or a single span replay, side-by-side, then promote to Experiment or save Prompt version. Mutable (re-run overwrites) — Experiments are immutable snapshots (U07).

---

## 2. Entry points

| From | Prefill |
|---|---|
| Span “Open in Playground” (U01) | Messages, model, tools, images |
| Dataset row | `{{input}}` / expected |
| Prompts library | Latest version body |
| Empty | Blank prompt + model picker |

---

## 3. Layout

```
┌ Title (editable) · Share URL · + Experiment · Save Prompt ──────────────┐
├ Tasks: [Base ▾] [+ Compare task]     Scorers: [+ Add]     Dataset: [▾]  │
├ Params: model · temp · max_tokens · tools · structured output · images  │
├─────────────────────────────────────────────────────────────────────────┤
│  Dataset rows (or single-shot)                                          │
│  ┌ Row 1 input ──┬ Task A output ┬ Task B output ┬ Scores A/B ┐       │
│  │ …             │ …             │ …             │ Δ badges   │       │
│  └───────────────┴───────────────┴───────────────┴────────────┘       │
├ Run (⌘⏎) · Diff on/off · Concurrency · Layout: Grid|List|Summary        │
└ History tab: past runs in this playground ──────────────────────────────┘
```

### Task types (F49)
1. **Prompt** — messages editor, Mustache vars, tools, response format
2. **Scorer-as-task** — validate a judge itself
3. **Remote / sandbox** (F69, later) — agent code

### Comparison UX (Braintrust)
- Green/red character diffs on outputs (cap 4k)
- Comparison grades on headers: Improvement / Regression / Tradeoff / Tie
- Diff toggle

---

## 4. Dataset binding

- Optional dataset; filters from dataset view carry over
- Variables: `{{input}}`, `{{expected}}`, `{{metadata.x}}`
- Max concurrency slider (default 5)
- Multimodal: image attachments when span has them (F78)

---

## 5. Scorers row

- Pick project scorers / Autoevals / inline LLM-judge
- Stream scores into cells as runs complete
- “Add online rule” deep-link to U14 with filter prefilled

---

## 6. Annotation lite (Pro path)

Thumbs up/down + note on a cell → **Optimize** opens Copilot (U16) with annotations → suggested prompt edit → Apply.

---

## 7. Exit ramps

| Action | Result |
|---|---|
| **+ Experiment** | Creates immutable F51 run per task |
| **Save Prompt** | New version in `/prompts` (F66/F68) |
| **Assign environment** | U17 staging/prod pin |
| **Share** | Org-members realtime sync via URL (Braintrust pattern) |

---

## 8. Keyboard

| Key | Action |
|---|---|
| `⌘⏎` | Run |
| `⌘S` | Save playground |
| `⌘D` | Toggle diff |
| `]` / `[` | Next / prev dataset row |

---

## 9. Empty state

> “Replay a production span or attach a dataset to compare prompts before you ship.”
>
> CTAs: Open from Traces · Create dataset from Issues

---

## 10. Acceptance criteria

- [ ] `/playgrounds` in Evaluate nav (core)
- [ ] Open from LLM span inherits messages/model/tools
- [ ] Side-by-side ≥2 tasks with score deltas
- [ ] Promote to Experiment and Save Prompt work
- [ ] Shared URL shows same config to org member
- [ ] Run p95 for 20-row × 1 task within provider SLA + 2s overhead

---

## 11. Performance & cost

- Stream token updates via SSE; cancel in-flight on Stop
- Org playground budget (N22-adjacent): soft cap $/day with banner
- Cache identical (prompt, model, input hash) results 1h optional
- Metrics: `eden_playground_run_seconds`, `eden_playground_cost_usd_total`
