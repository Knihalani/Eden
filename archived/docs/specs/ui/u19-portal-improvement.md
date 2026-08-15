# U19: Portal Improvement — Surface Density Pass

| Field | Value |
|---|---|
| **Spec ID** | U19 |
| **Priority** | P0 |
| **Effort** | XL |
| **Eden status** | MISSING as coordinated program |
| **Clone targets** | Laminar density; Braintrust table OS; Langfuse filters |
| **Dependencies** | U18 complete; U01–U17 at least v0 |
| **Roadmap** | **Wave 12** |

> **Overhaul 2026 status (2026-07-20):** Density / empty / cross-link work advanced in Waves 5–6 (hub QueryState, empty/error voice, Traces ViewsMenu + master–detail). Residual gaps deferred: Issues/Alerts `ViewsMenu` dirty-views OS; Trace detail Timeline mode. See [`overhaul-2026/w6-qa-matrix.md`](./overhaul-2026/w6-qa-matrix.md) and [`overhaul-2026/README.md`](./overhaul-2026/README.md).

---

## 1. Summary

Bring **every core surface** to competitor density on the U18 shell: working filters, bulk actions, keyboards, teaching empty states, deep links, cross-links. No net-new backend features.

---

## 2. Per-surface checklist (must pass)

| Check | Bar |
|---|---|
| FilterBar + saved views | U08 wired |
| Bulk actions | U00 registry |
| Keyboard | Cheat sheet; j/k on lists |
| Empty state | Gap 4.8 + one CTA |
| Error state | Retry + request id (F84) |
| Loading | Skeleton = density |
| Deep link | URL restores selection + filters |
| Cross-links | Matrix §3 |
| Permissions | Disabled + reason |

### Core surfaces
Home, Traces, Issues, Incidents, Alerts, Artifacts, Book, Drift, Improve, Playgrounds, Experiments, Datasets, Settings (critical tabs), Debugger sessions, Online rules, Prompts/envs.

### Rule
If a page cannot pass → Advanced + "Limited" badge OR remove from nav.

---

## 3. Cross-link matrix (required)

| From | To | Action |
|---|---|---|
| Trace | Issue | Create / view linked |
| Trace | Artifact | Create from failure |
| Trace | Playground | Open span |
| Trace | Dataset | Add rows |
| Trace | Labeling queue | Seed |
| Issue | Experiment | F33 |
| Issue | Artifact | Create |
| Alert | Incident | Group |
| Alert | Traces | Examples |
| Artifact | Traces | Outcomes |
| Drift | Traces | Dimension filter |
| Dataset | Playground | Run |
| Dataset | Experiment | Run |
| Experiment | Trace | Datapoint panel |

---

## 4. Work packages

| WP | Surfaces |
|---|---|
| WP1 | Traces + Sessions (U01) reference density |
| WP2 | Issues + Incidents |
| WP3 | Alerts (U04) |
| WP4 | Artifacts + Improve (U02) |
| WP5 | Book + Drift (U05) |
| WP6 | Datasets + Labeling (U10/U06) |
| WP7 | Playground + Experiments (U03/U07) |
| WP8 | Home + Settings critical (U09) |
| WP9 | Debugger + Automations + Prompts (U13/U14/U17) |
| WP10 | Cross-link matrix sweep + design sign-off |

---

## 5. Acceptance criteria

- [ ] Every core surface passes §2
- [ ] Cross-link matrix implemented
- [ ] No core list-only page without detail/CTA
- [ ] Advanced-only pages absent from default nav
- [ ] Design sign-off: Traces, Artifacts, Playground, Alerts

---

## 6. Exit to Wave 13

Density signed off → U20 polish only (no structural rewrites).
