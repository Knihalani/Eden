# U12: Portal Information Architecture Rewrite

| Field | Value |
|---|---|
| **Spec ID** | U12 |
| **Priority** | P0 |
| **Effort** | M |
| **Eden status** | PARTIAL — sidebar-config exists; too many first-class items |
| **Clone targets** | Helicone grouping; Laminar project nav density |
| **Dependencies** | `sidebar-config.ts`, `portal-routes.ts`, U18 |
| **Roadmap** | Wave 3 seed; Wave 11 freeze |

---

## 1. Locked core nav (≤12)

```
Home                         /dashboard
Observe
  Traces                     /traces
  Issues                     /issues
  Incidents                  /incidents
  Alerts                     /alerts
Improve
  Artifacts                  /artifacts
  Book                       (agent picker → /agents/[id]/book)
  Drift                      (agent picker → /agents/[id]/drift)
  Improve queue              /improve
Evaluate
  Playgrounds                /playgrounds
  Experiments                /experiments
  Datasets                   /datasets
Settings                     /settings
```

Count core leaf items carefully — keep ≤12 visible defaults (group labels don't count).

---

## 2. Advanced (hidden by default)

Signals, Fleet, Replay, Observability hub children, Tools, Inspector, Users, LLMOps, Analytics, Optimization*, Guardrails, Redteam, Autonomous, Closed-loop, PR suggestions, Labeling, Prompts, Connect repo, Studio, Debugger sessions, SQL/EQL, Topics, Cost deep pages, etc.

\* One Cost entry may stay core if plan-critical.

---

## 3. Rules

1. Book/Drift without agent context → agent picker modal
2. Badges: Alerts (real unacked), Artifacts (candidates ready), Improve (needs you)
3. ⌘K indexes core + Advanced
4. User sidebar prefs layer on defaults (pin/hide/reorder)
5. Every `page.tsx` under `(portal)/` must appear in sidebar-config OR explicit `unlisted` allowlist with reason
6. Renames get redirects in `next.config` / portal-routes

---

## 4. Acceptance criteria

- [ ] Core visible ≤12
- [ ] Artifacts/Book/Drift discoverable without hunting
- [ ] `/signals` Advanced until F06 ready
- [ ] Zero broken hrefs; redirects for renames
- [ ] portal-routes.ts ↔ sidebar-config.ts agreement test in CI

---

## 5. Migration

Ship config change behind flag `portal.ia_v2`; default on after Wave 11 U18.
