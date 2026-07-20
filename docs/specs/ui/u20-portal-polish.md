# U20: Portal Polish — Consistency, A11y, Motion, Delight

| Field | Value |
|---|---|
| **Spec ID** | U20 |
| **Priority** | P1 |
| **Effort** | L |
| **Eden status** | MISSING as coordinated program |
| **Dependencies** | U18, U19 |
| **Roadmap** | **Wave 13** |

> **Overhaul 2026 status (2026-07-20):** Wave 6 delivered a11y focus rings (`FOCUS_RING`), motion restraint, hub microcopy, and auth/marketing token sync. Live axe still needs a portal on `:3000` — see [`overhaul-2026/w6-a11y-evidence.md`](./overhaul-2026/w6-a11y-evidence.md). Rollup: [`overhaul-2026/README.md`](./overhaul-2026/README.md).

---

## 1. Summary

Final polish after structure + density: accessibility, motion, microcopy, visual consistency, toasts, focus rings, reduced-motion. No new features or nav changes.

---

## 2. Workstreams

### 2.1 Visual consistency
- Spacing / radius / border tokens only
- Unified Badge, Chip, Severity, Status components
- Shared chart colors (Home, Drift, Experiments)
- Light/dark parity if both themes exist

### 2.2 Accessibility
- WCAG 2.2 AA on core flows
- Focus order: table → panel → tabs
- Icon-only buttons have aria-labels
- Contrast on severity colors
- Skip-to-content link

### 2.3 Motion
- Only: panel open, live append pulse, row select highlight
- `prefers-reduced-motion` disables non-essential
- No animation on table virtualization scroll

### 2.4 Microcopy
- Plain-language empty states (Gap 4.8)
- Actionable errors
- Onboarding banners dismiss + resume

### 2.5 Feedback
- Toasts on promote / ack / approve / save / regenerate
- Confirm only for irreversible archive/delete
- Undo where safe (view discard)

---

## 3. Work packages

| WP | Focus |
|---|---|
| WP1 | Token + component unification |
| WP2 | A11y pass Home/Traces/Issues/Artifacts/Playground |
| WP3 | Motion + reduced-motion |
| WP4 | Empty/error microcopy sweep |
| WP5 | Toast coverage audit |
| WP6 | Axe CI gate on core routes |

---

## 4. Acceptance criteria

- [ ] Axe: no critical on Home, Traces, Issues, Artifacts, Playground
- [ ] Reduced-motion respected
- [ ] Severity/badge components universal (no one-offs on core)
- [ ] Empty states match Gap 4.8 voice guide
- [ ] Toasts on all core mutations
- [ ] Axe CI job required on main

---

## 5. Explicit non-goals

New nav items; new backends; marketing rebrand; pixel-clone competitor skins.

---

## 6. Exit to Wave 14

Polish signed off → F82–F85 optimization & debugging only.
