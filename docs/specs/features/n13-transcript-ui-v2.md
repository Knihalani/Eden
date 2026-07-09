# N13: Transcript UI v2 (Notion-Style Agent Conversations)

| Field | Value |
|---|---|
| **Feature ID** | N13 |
| **Slug** | `transcript-ui-v2` |
| **Priority** | P2 |
| **Effort** | L |
| **Eden status** | **PARTIAL** (`TranscriptView.tsx` basic) |
| **Restores** | Deleted F38 (transcript UI v2) |
| **Market hypothesis** | Raindrop's transcript polish is cited in demos — portal first impression matters |
| **Dependencies** | F09 browser replay, F21 tool labels |

---

## 1. Problem

Eden `TranscriptView.tsx` renders steps linearly. Raindrop shows Notion-style blocks, parallel tool swimlanes, inline screenshots, keyboard navigation. For complex multi-tool agents, linear view is **hard to debug** — slow cognitive load = bad client experience.

---

## 2. Target behavior

### Layout
- **Blocks:** user, assistant, tool, system — distinct typography/icons
- **Parallel swimlanes:** concurrent tool calls side-by-side
- **Collapsible:** long tool results default collapsed with expand
- **Inline media:** F09 screenshots, RRWeb thumbnail → replay panel
- **Annotations:** F21 good/bad labels on tool rows

### Interactions
- `j/k` vim nav between steps
- `⌘+F` in-trace search (highlight)
- Copy step JSON / share permalink
- "Rerun from here" → F01 debugger (when fixed)

---

## 3. Architecture

```
clients/portal/src/components/transcript-v2/
  TranscriptV2.tsx          # orchestrator
  blocks/                   # UserBlock, AssistantBlock, ToolBlock
  ParallelToolLane.tsx
  StepNavigator.tsx
  useTranscriptKeyboard.ts
```

**Data:** Existing trace step API — no backend change required for v1.

---

## 4. Performance & cost optimization

| Concern | Mitigation |
|---|---|
| Large traces (200+ steps) | Virtualized list (react-window); render ±20 visible |
| Heavy tool payloads | Lazy fetch on expand; show 500 char preview |
| Images | Lazy load + thumbnail CDN; WebP |
| Initial paint | p95 <1s for 50-step trace (virtualized) |

**No LLM cost** — pure frontend.

**Bundle size:** Code-split `transcript-v2` chunk; load on trace page only (~80KB gzipped target).

---

## 5. Rollout

| Flag | Behavior |
|---|---|
| `transcript_v2_v1` | Opt-in per org |
| Default | v1 TranscriptView until stable |

A/B: measure time-on-page and debugger click-through rate.

---

## 6. Acceptance criteria

- [ ] 50-step trace interactive scroll p95 <1s first paint
- [ ] Parallel tools render in swimlanes not stacked
- [ ] Keyboard nav works (j/k, expand/collapse)
- [ ] RRWeb thumbnail opens F09 replay panel
- [ ] Feature flag toggles v1/v2 without reload break

---

*Restored from deleted F38. Portal polish that supports F01/F21/F09 workflows.*
