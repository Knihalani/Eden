# U16: In-UI Copilot

| Field | Value |
|---|---|
| **Spec ID** | U16 |
| **Priority** | P2 |
| **Clone targets** | Braintrust Loop; Laminar Agent; Langfuse Assistant |
| **Dependencies** | F70, ChatSidebar, U08, U18 |
| **Surface** | Global bottom-right + contextual |
| **Roadmap** | Wave 10; Wave 13 |

---

## 1. Capabilities by page

| Page | Actions (mutations approval-gated) |
|---|---|
| Traces | Summarize, NL→filter, find similar, create dataset |
| Trace detail | Cite spans, explain error, open debugger |
| Playground | Optimize from annotations |
| Datasets | Generate rows, propose schema |
| Experiments | Summarize deltas |
| Home | NL chart creation |
| Anywhere | Docs search |

---

## 2. Chrome

Bottom-right chat; model picker; `@` context; `/` slash (`/generate-filter`, `/find-similar`); conversation history; Enter interrupts.

---

## 3. Rules

- Mutations require explicit Approve (show SQL/filter preview first)
- Span citations jump to U01
- Respect org AI provider settings
- No silent writes

---

## 4. Acceptance criteria

- [ ] NL→filter on Traces works
- [ ] Span citations navigate correctly
- [ ] No silent writes without approval
- [ ] Works with ChatSidebar without double chrome

---

## 5. Cost

SLM default; show token/cost estimate before long runs; org budget hook.
