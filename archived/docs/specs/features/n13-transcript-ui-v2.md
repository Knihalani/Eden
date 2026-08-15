# N13: Transcript UI v2 (Notion-Style Agent Conversations)

| Field | Value |
|---|---|
| **Feature ID** | N13 |
| **Slug** | `transcript-ui-v2` |
| **Priority** | P2 |
| **Effort** | L |
| **Eden status** | **PARTIAL** (`TranscriptView.tsx` basic) |
| **Restores** | Deleted F38 (transcript UI v2) |
| **Market hypothesis** | Raindrop's transcript polish is cited in demos — portal first impression drives maintenance adoption |
| **Dependencies** | F09 browser replay, F21 tool labels, F01 debugger, N11, N12 |

---

## 1. Summary

**Notion-style transcript** for complex multi-tool agent runs — block layout, parallel tool swimlanes, inline media, keyboard navigation, and maintenance actions (label, rerun, create issue). Pure frontend upgrade on existing trace API; dramatically reduces time-to-diagnose for operator and coding-agent-assisted maintenance.

---

## 2. Eden current state

| Shipped | Path | Gap |
|---|---|---|
| `TranscriptView.tsx` | `clients/portal/` | Linear steps only |
| Trace step API | backend | Sufficient for v2 |
| F09 RRWeb replay | partial | Not inline in transcript |
| F21 labels | spec | No UI hooks |
| F01 debugger | spec | "Rerun from here" blocked on F48 |

---

## 3. Target behavior

### Layout
- **Blocks:** user, assistant, tool, system — distinct typography/icons/colors
- **Parallel swimlanes:** concurrent tool calls side-by-side (detect overlapping span timestamps)
- **Collapsible:** long tool results default collapsed; expand loads lazy payload
- **Inline media:** F09 screenshots, RRWeb thumbnail → replay side panel
- **Annotations:** F21 good/bad labels on tool rows; stumble badges from F28
- **Maintenance bar:** Create issue (F29), Add to regression (N01), Open in Cursor (F04)

### Interactions
- `j/k` vim nav between steps; `h/l` between parallel lanes
- `⌘+F` in-trace search with highlight
- Copy step JSON / share permalink to step
- **"Rerun from here"** → F01 debugger (when F48 fixed)
- N11: live block append with subtle animation

### Operator vs coding-agent
- Portal: full UX
- F04 MCP: `get_trace_transcript_structured(trace_id)` returns block JSON for agent reasoning

---

## 4. Architecture

```
clients/portal/src/components/transcript-v2/
  TranscriptV2.tsx              # orchestrator + feature flag
  blocks/UserBlock.tsx
  blocks/AssistantBlock.tsx
  blocks/ToolBlock.tsx
  blocks/SystemBlock.tsx
  ParallelToolLane.tsx          # groups spans by time overlap
  StepNavigator.tsx             # minimap + j/k
  MaintenanceActionBar.tsx
  hooks/useTranscriptKeyboard.ts
  hooks/useParallelGroups.ts    # span overlap algorithm
  hooks/useLazyToolPayload.ts
```

**Data flow:** Existing `GET /v1/traces/{id}/steps` — client-side grouping only for v1.

**Parallel detection:** Spans A,B parallel if `A.start < B.end && B.start < A.end` and same parent.

---

## 5. Structured transcript schema (MCP export)

```json
{
  "trace_id": "...",
  "blocks": [
    {"type": "user", "step_index": 0, "content": "...", "timestamp": "..."},
    {
      "type": "parallel_tools",
      "step_index": 1,
      "lanes": [
        {"tool_name": "bash", "span_id": "...", "status": "ok", "preview": "..."},
        {"tool_name": "read_file", "span_id": "...", "status": "error"}
      ]
    }
  ],
  "stumbles": [{"kind": "loop", "step_index": 3}],
  "labels": [{"span_id": "...", "label": "bad", "reason": "..."}]
}
```

---

## 6. API specification

No new backend required for v1. Optional v2 enhancements:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/traces/{id}/transcript-structured` | Server-side block grouping (cache) |

**MCP (F04):** `get_trace_transcript_structured(trace_id)`

---

## 7. Implementation plan

1. `useParallelGroups` hook + unit tests on fixture traces
2. Block components + design tokens (match portal system)
3. Virtualized list (react-window) for 200+ steps
4. Lazy tool payload fetch on expand
5. F09 thumbnail + replay panel integration
6. F21 label buttons → POST label API
7. Keyboard nav + in-trace search
8. Feature flag v1/v2 toggle
9. MCP structured export (optional server route)

---

## 8. Rollout

| Flag | Behavior |
|---|---|
| `transcript_v2_v1` | Opt-in per org |
| Default | v1 TranscriptView until stable |

A/B metrics: time-on-page, debugger click-through, issue-create rate, F21 label usage.

---

## 9. Test plan

- 50-step trace: first paint p95 <1s (virtualized)
- Parallel bash+read_file spans → swimlane not stacked
- Expand collapsed tool → lazy fetch fires once
- j/k navigation focuses correct block
- Feature flag off → v1 renders, no errors
- 200-step trace: scroll performance 60fps

---

## 10. Acceptance criteria

- [ ] 50-step trace interactive scroll p95 <1s first paint
- [ ] Parallel tools render in swimlanes not stacked
- [ ] Keyboard nav works (j/k, expand/collapse)
- [ ] RRWeb thumbnail opens F09 replay panel
- [ ] Feature flag toggles v1/v2 without reload break
- [ ] F21 label buttons persist labels
- [ ] Maintenance bar creates F29 issue draft
- [ ] MCP structured transcript matches portal grouping

---

## 11. Performance & cost optimization

### Latency budgets

| Operation | p50 | p95 | p99 |
|---|---|---|---|
| First paint (50 steps) | 400ms | 900ms | 1s |
| Lazy payload fetch | 100ms | 400ms | 800ms |
| In-trace search | 20ms | 80ms | 150ms |
| Parallel grouping (client) | 10ms | 40ms | 100ms |

### Cost model

- **LLM tier:** 0 — pure frontend
- **CDN/bandwidth:** lazy load reduces initial payload ~70%
- **Optional server grouping cache:** Redis 5min — $0 compute

### Bundle size

- Code-split `transcript-v2` chunk; load on trace page only
- Target ~80KB gzipped incremental

### Degradation modes

- Lazy fetch fail → show "payload unavailable" inline
- RRWeb missing → hide thumbnail gracefully
- Very large payload (>1MB) → truncate preview, download link

### Monitoring (client RUM)

```
eden_transcript_v2_first_paint_ms
eden_transcript_v2_lazy_fetch_errors_total
eden_transcript_v2_parallel_group_count_histogram
eden_transcript_v2_label_actions_total
```

---

## 12. Dependencies

| Spec | Relationship |
|---|---|
| F09 | Inline replay |
| F21 | Tool labels |
| F01 | Rerun from here |
| F48 | Debugger API contract |
| N11 | Live append |
| N12 | Navigate from session card |
| F04 | MCP structured export |

---

*Restored from deleted F38. Portal polish that accelerates F01/F21/F09 maintenance workflows.*
