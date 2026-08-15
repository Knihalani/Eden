# U01: Traces Hub (Laminar-class)

| Field | Value |
|---|---|
| **Spec ID** | U01 |
| **Priority** | P0 |
| **Effort** | XL |
| **Eden status** | PARTIAL — `/traces` table + live tail; detail navigates away; full `TranscriptView.tsx` **unwired** |
| **Clone targets** | Laminar `/project/{id}/traces?view=traces\|spans\|sessions`; Braintrust Logs panel |
| **Dependencies** | U00, U08, N11, N12, N13, F12, F49 (open in playground) |
| **Routes** | `/traces` (hub), `/traces?traceId=`, `/sessions/{sessionId}` |

---

## 1. Summary

One Observe hub: **Traces | Spans | Sessions**. Clicking a row opens an **inline split pane** (transcript default). This is the page operators live in — must match Laminar density.

---

## 2. Information architecture

### Hub tabs (`?view=`)
| Tab | Row meaning | Default columns |
|---|---|---|
| **Traces** | One agent/LLM run | status, id, root name, input/output preview, time, duration, cost, tokens, agent, session, user, tags |
| **Spans** | Flat span search | name, type, status, duration, tokens, parent trace |
| **Sessions** | Grouped turns | session id, turns, duration, cost, tokens, user, last activity |

### URL contract
```
/traces?view=traces&pastHours=24&filter=...&traceId=...&spanId=...&chat=false
/sessions/{sessionId}
/traces/{traceId}          # fullscreen (optional)
```

---

## 3. Layout — Traces tab

```
┌ FilterBar · Views · Display · Live ▾ · Search ──────────────┬ LiveTail 18rem ┐
├ Trace table (selected row highlighted) ─────────────────────┤ SSE events     │
│                                                             ├────────────────┤
│  ┌─ Detail panel (when ?traceId=) ──────────────────────────────────────────┐│
│  │ Header: id · status · cost · tokens · session pill · user · Share · ⛶   ││
│  │ Modes: [Transcript] [Tree] [Timeline] [Metadata]   Search spans          ││
│  │ Body: view content + optional Signals strip                              ││
│  │ Span pane (right): I/O Messages|JSON|YAML|Text · Tags · Actions          ││
│  └──────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
```

**Do not** navigate to `/observability?trace_id=` for primary open. Keep deep links working via redirect shim.

---

## 4. Transcript mode (wire existing component)

**Source:** `clients/portal/src/components/observability/TranscriptView.tsx` (full) — currently unused; `transcript-view.tsx` (simple) used only in inspector.

### Blocks
- Agent/subagent **Input** cards (collapsed by default for nested)
- LLM turns (messages pretty-printed)
- Tool calls: one-line preview → expand lazy payload
- Stumble badges (F28), signal chips (F06)

### Keyboard (N13)
| Key | Action |
|---|---|
| `j` / `k` | Next / prev block |
| `Enter` | Expand / open span pane |
| `⌘F` | In-trace search |
| `r` | Rerun from here (F01 when ready) |
| `d` | Add span to dataset |
| `q` | Add to labeling queue |
| `i` | Create issue from selection |

---

## 5. Tree mode

- Virtualized parent/child list
- Duration bar + tokens/cost on LLM nodes
- Collapse branch; minimap for large traces
- Sync selection with Timeline playhead

---

## 6. Timeline mode (Gantt)

- Condensed bars by span
- Cmd/Ctrl+scroll zoom; drag-select range → filter table to range
- Session playhead when opened from session
- Optional browser replay sync (F09)

---

## 7. Span detail pane actions

| Action | Target |
|---|---|
| Open in Playground | F49 / U03 — prefill messages, model, tools |
| Add to Dataset | F53 — create or append row |
| Add to Labeling Queue | F50 / U06 |
| Open in SQL/EQL | `/observability/query` prefilled `WHERE trace_id=` |
| Tag / Annotate | Langfuse-style score dialog (already partially on traces) |
| Copy permalink | includes `traceId` + `spanId` |
| Export JSON | span or full trace |

**I/O modes:** Messages | JSON | YAML | Text | Custom template (U15)

---

## 8. Sessions tab + full session page (N12)

### Sessions table
Columns: id, turn count, duration, cost, tokens, user, last_active. Click → `/sessions/{id}`.

### Session page layout
```
Header: session id · duration · tokens · cost · user · Timeline toggle
Search: text / span name / id / tags
┌ Turn card 1/N: Input preview + final LLM output ──────────────┐
│ …                                                             │
└ Turn card N/N ────────────────────────────────────────────────┘
```
Per card: open trace (sets hub `traceId`), copy id. Timeline shows turns on one axis.

---

## 9. Live behavior (N11)

- LiveTail right rail stays
- When detail open + Live on: new spans append into Transcript/Tree with subtle pulse
- Badge “Live” on header; pause freezes append

---

## 10. Empty states

| Case | Copy | CTA |
|---|---|---|
| No traces ever | “Send your first agent run” | Connect SDK / Gateway docs |
| Filters empty | “No traces match” | Clear · Save as alert |
| Session empty | “No turns in range” | Expand time |

---

## 11. Acceptance criteria

- [ ] Traces | Spans | Sessions on one route
- [ ] Opening a trace does not leave `/traces` on desktop
- [ ] Full `TranscriptView.tsx` is the default detail mode
- [ ] Session page shows numbered turn cards with cost header
- [ ] Open in Playground / Dataset / Queue works from span pane
- [ ] Share URL restores filter + selected trace
- [ ] p95 open detail < 1.2s (PERFORMANCE-COST-STANDARDS)

---

## 12. Implementation plan

1. Refactor `/traces/page.tsx` onto U00 `ResourcePageShell`
2. Mount TranscriptView; add Tree + Timeline toggles
3. Stop navigation to observability hub for selection; shim old links
4. Build `/sessions/[id]` page
5. Wire span actions to dataset/queue/playground APIs
6. Adopt FilterBar + saved views (U08)
