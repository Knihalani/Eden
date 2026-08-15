# U10: Datasets Spreadsheet

| Field | Value |
|---|---|
| **Spec ID** | U10 |
| **Priority** | P1 |
| **Effort** | L |
| **Eden status** | PARTIAL — basic DataTable |
| **Clone targets** | Braintrust / LangSmith / Phoenix datasets |
| **Dependencies** | F53, F44, F50, U03, U06, U18 |
| **Routes** | `/datasets`, `/datasets/[id]` |
| **Roadmap** | Wave 5; Wave 12 |

---

## 1. List page

U00 ResourcePageShell: search, tags, saved views, star, create (empty / upload / from traces).

Columns: name, rows, updated, source (manual|auto_curator|import), tags.

---

## 2. Detail — spreadsheet

```
┌ Name · Snapshots ▾ · Run in Playground · New experiment · Export ───────────┐
├ FilterBar · schema enforce toggle · AI fill (optional)                        │
├ Spreadsheet: input | expected | metadata.* | tags | origin (→ trace)          │
│  Inline cell edit · add row · delete · multi-select                           │
└ Selection bar: Add to queue · Run playground · Export selected ───────────────┘
```

### Import
CSV/JSONL upload → column mapping preview (Input / Expected / Metadata / Tags / Skip) → commit.

### Snapshots (F53)
Save named pin → use in Playground / Experiment / env (U17). Restore creates new snapshot (push-only).

### Origin
When row from production span: Log button opens U01.

---

## 3. Keyboard

| Key | Action |
|---|---|
| `e` | Edit focused cell |
| `⌘S` | Save |
| `⌘⏎` | Run selection in playground |
| `j/k` | Row nav |

---

## 4. Acceptance criteria

- [ ] Inline edit + import mapping
- [ ] From-traces bulk add with origin links
- [ ] Snapshot → playground / experiment
- [ ] F44 auto slices visible with source badge
- [ ] Virtualized rows for ≥1k

---

## 5. Performance

Row page p95 <400ms; import 10k rows <30s; no LLM on read path.
