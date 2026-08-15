# U18: Portal Overhaul — Structural Rebuild

| Field | Value |
|---|---|
| **Spec ID** | U18 |
| **Priority** | P0 |
| **Effort** | XL |
| **Eden status** | MISSING as coordinated program — pieces in U00/U12 |
| **Clone targets** | Laminar project shell; Braintrust app chrome; Helicone nav clarity |
| **Dependencies** | U00, U08, U12, F58, product surfaces from Waves 4–10 |
| **Roadmap** | [EDEN-MASTER-ROADMAP](../EDEN-MASTER-ROADMAP.md) **Wave 11** |

> **Overhaul 2026 status (2026-07-20):** Structural U18 goals are largely shipped via Waves 4–6 (shell, IA freeze, ResourcePageShell, redirects, mobile More, clutter contracts). Program rollup: [`overhaul-2026/README.md`](./overhaul-2026/README.md). Residual peer gaps (ViewsMenu on Issues/Alerts, Timeline mode, live axe) tracked as maintenance — not a rewrite of this spec.

---

## 1. Summary

A **dedicated structural overhaul** of the logged-in portal — not page-by-page tweaks. One app shell, one navigation model, one detail-panel contract, one command palette, one token system, zero orphan layouts. Opening Eden must feel like one product.

---

## 2. Problem statement (current)

- 80+ routes with inconsistent scaffolding
- Trace detail navigates away from list (breaks Laminar master–detail)
- Advanced items leak into default mental model
- Multiple layout patterns (`PageHeader` variants, ad-hoc grids)
- Command palette incomplete vs sidebar
- Mobile bottom nav ≠ desktop IA

---

## 3. Scope (in)

1. **App shell** — collapsible sidebar, top bar, breadcrumbs, org/project switcher, budget ticker, AI rail mount, notification bell
2. **IA freeze** — U12 core ≤12; Advanced drawer; dead-link purge; redirects
3. **ResourcePageShell** on all core routes
4. **DetailPanelShell** for traces, issues, alerts, artifacts, experiments, incidents
5. **Command palette ⌘K** — routes + actions (create alert, open playground, go to issue)
6. **Mobile shell** — bottom nav 5 items; detail as drawer; tables scroll correctly
7. **Design tokens** — CSS variables only; density Comfortable/Compact global preference
8. **Route registry** — `portal-routes.ts` ↔ `sidebar-config.ts` CI agreement test
9. **Redirect map** — old URLs (`/observability?trace_id=`) → new contracts
10. **Storybook / fixtures** — shell states: loading, empty, error, collapsed, mobile

---

## 4. Scope (out)

| Out | Owner |
|---|---|
| Density / cross-links / empty copy | U19 Wave 12 |
| A11y / motion / microcopy delight | U20 Wave 13 |
| Virtualization / Web Vitals CI | F82 Wave 14 |
| New product features | Waves 1–10 |

---

## 5. Target IA (locked)

```
Home
Observe: Traces · Issues · Incidents · Alerts
Improve: Artifacts · Book · Drift · Improve queue
Evaluate: Playgrounds · Experiments · Datasets
Settings
Advanced: …
```

Book/Drift: agent picker when no agent in context.

---

## 6. Component inventory

```
clients/portal/src/components/portal-os/
  AppShell.tsx
  ResourcePageShell.tsx
  DetailPanelShell.tsx
  CommandPalette.tsx
  MobileBottomNav.tsx
  DensityProvider.tsx
  stubs/ for Storybook
```

Wire into `(portal)/layout.tsx` — replace one-off chrome.

---

## 7. Migration order (work packages)

| WP | Work |
|---|---|
| WP1 | AppShell + token pass + density |
| WP2 | ResourcePageShell + DetailPanelShell APIs |
| WP3 | Migrate Traces (reference) |
| WP4 | Migrate Issues, Incidents, Alerts |
| WP5 | Migrate Artifacts, Improve, Book/Drift entry |
| WP6 | Migrate Playgrounds, Experiments, Datasets, Home |
| WP7 | Advanced quarantine + redirects |
| WP8 | ⌘K completeness + mobile shell |
| WP9 | CI route agreement test + Storybook |
| WP10 | QA matrix desktop/tablet/mobile |

---

## 8. Detail panel contract

Props (conceptual): `open`, `onClose`, `title`, `tabs[]`, `actions[]`, `children`, `onPrev`, `onNext`.  
Keyboard: `Esc` close, `j/k` prev/next when list focused.  
URL: resource-specific id query param; shareable.

---

## 9. Acceptance criteria

- [ ] All core routes use ResourcePageShell
- [ ] Core visible nav ≤12
- [ ] ⌘K opens every core + Advanced route + ≥5 actions
- [ ] Detail panel API identical across ≥5 resources
- [ ] No marketing/orphan layouts in `(portal)/`
- [ ] Mobile: core flows without horizontal scroll traps
- [ ] portal-routes ↔ sidebar-config CI test green
- [ ] Old trace deep links redirect correctly
- [ ] Storybook covers shell states

---

## 10. Performance

Shell chrome TTI <100ms p95 cached; no CLS on sidebar collapse; layout shift budget 0.1.

---

## 11. Exit to Wave 12

U18 DoD met → start U19 density pass on the new shell only (do not polish old layouts).
