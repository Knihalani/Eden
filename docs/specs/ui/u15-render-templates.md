# U15: Custom Render Templates

| Field | Value |
|---|---|
| **Spec ID** | U15 |
| **Priority** | P2 |
| **Clone targets** | Laminar render templates |
| **Dependencies** | F59, U01, U06, U16 optional |
| **Route** | `/settings/render-templates` |
| **Roadmap** | Wave 10; Wave 13 polish |

---

## 1. Editor

- Scope: span \| trace
- Sandboxed JSX/HTML
- Preview on live span picker
- AI Generate / Request changes (U16) with approval
- Stick template while paging eval datapoints / queue items

---

## 2. Usage

U01 Custom view mode; U06 Data pane; Experiments review.

---

## 3. Acceptance criteria

- [ ] Custom mode selectable in transcript
- [ ] Labeling queue can use template
- [ ] Sandbox blocks network/exfil
- [ ] Unsafe code rejected with clear error

---

## 4. Security

iframe sandbox / CSP; no org secrets in template context; size limits.
