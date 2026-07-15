# U06: Annotation Queue Workstation

| Field | Value |
|---|---|
| **Spec ID** | U06 |
| **Priority** | P1 |
| **Effort** | L |
| **Eden status** | MISSING UX — `/labeling` read-only table |
| **Clone targets** | Laminar labeling queues; Weave; LangSmith |
| **Dependencies** | F50, F53, F21, U01, U15, U18 |
| **Routes** | `/labeling`, `/labeling/queues/[id]` |
| **Roadmap** | Wave 5; Wave 12 |

---

## 1. Summary

Keyboard-first SME workstation: review production spans, edit targets, approve/discard, pairwise A/B, push to datasets. Schema-driven fields with hotkeys `1–9`.

---

## 2. Queue list

U00 shell: name, progress, type (standard|pairwise), updated. Create queue → schema builder (categorical / continuous / free-text).

Seed: from traces multi-select, dataset, SQL export (F76).

---

## 3. Workstation layout (Laminar parity)

```
┌ Queue · progress 42/100 · segment navigator (new / modified / approved) ─────┐
├──────────── Data (read-only) ──────────┬── Target (editable) ────────────────┤
│ Transcript / span / U15 template       │ JSON + Fields form · hotkeys 1–9    │
├────────────────────────────────────────┴─────────────────────────────────────┤
│ [⌘⌫ Discard] [⌘← Prev] [⌘→ Next] [⌘⏎ Approve]  Push to dataset ▾           │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Auto-save target on blur (debounce 500ms)
- Reservation lease 15m + heartbeat; another user sees "Reserved by X"
- Navigator: click/drag segments; colors match status

---

## 4. Pairwise mode

Side-by-side A/B (blind optional), pick winner + margin → `labeling_pairwise_results`. Feeds F77 DPO export.

---

## 5. Keyboard map

| Shortcut | Action |
|---|---|
| `⌘⏎` | Approve |
| `⌘⌫` | Discard |
| `⌘←` / `⌘→` | Navigate |
| `1–9` | Categorical field option |
| `t` | Focus free-text |
| `d` | Push current to dataset |
| `?` | Cheat sheet overlay |

---

## 6. Acceptance criteria

- [ ] Approve/skip/discard works (not list-only)
- [ ] Hotkeys documented in-product
- [ ] Reservations prevent double-edit
- [ ] Pairwise writes winner/loser
- [ ] Push approved → dataset
- [ ] Seed from U01 multi-select

---

## 7. Performance

Item fetch <300ms p95; auto-save debounce 500ms; no LLM on critical path.
