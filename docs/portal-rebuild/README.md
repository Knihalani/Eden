# Eden Portal Rebuild — Master Spec

> **Status:** Authoritative. Supersedes incremental overhaul plans under `clients/portal/PORTAL_*.md` for the greenfield rebuild.  
> **Decision date:** 2026-07-21  
> **Owner:** Product (Kai) + Portal rebuild track  
> **North-star UI:** [Laminar](https://laminar.sh/) — density, transcript-first, agent-as-primary object, Signals-style diagnosis.  
> **Product wedge:** Closed loop **failure → fix artifact → PR**, delivered as **gateway + observe + improve in one product**.

---

## Hand this to implementers

**Phase work orders:** [`PHASES.md`](./PHASES.md)

Say: *completely execute Phase 1 in `docs/portal-rebuild/PHASES.md`*

That file is the binding implementation contract (objectives, file tree, sequence, gates, Definition of Done). Other docs in this folder are detail it requires you to read per phase.

---

## Why this exists

The current portal is unusable: cluttered chrome, ~75 routes, hub-of-hubs, dual entry points, inconsistent components, and broken mobile adaptation. Incremental waves cannot recover trust. This directory is the **complete contract** for tearing down `clients/portal` authenticated product UI and rebuilding it from a stub.

**Docs site** (`docs/`) and **i18n** (en/de) are preserved. Everything else in the portal app is in scope for replacement.

---

## Reading order

| # | Doc | Purpose |
|---|-----|---------|
| ★ | [**PHASES.md**](./PHASES.md) | **Phase work orders — completely execute Phase N here** |
| 0 | [00-vision.md](./00-vision.md) | One-page vision, wedge, non-goals, success criteria |
| 1 | [01-product-bible.md](./01-product-bible.md) | Users, JTBD, object model, closed-loop grammar |
| 2 | [02-information-architecture.md](./02-information-architecture.md) | Nav, URL grammar, hubs, kill list |
| 3 | [03-competitive-synthesis.md](./03-competitive-synthesis.md) | Laminar / TraceRoot / Langfuse / Braintrust / others → steal / skip |
| 4 | [design/DESIGN-SYSTEM-V2.md](./design/DESIGN-SYSTEM-V2.md) | Tokens, density, chrome, components, motion, a11y, mobile |
| 5 | [surfaces/](./surfaces/) | Hyper-detailed per-surface specs (every must-ship page) |
| 6 | [engineering/00-overview.md](./engineering/00-overview.md) | Stack, package layout, data layer, milestones |
| 7 | [engineering/01-teardown-runbook.md](./engineering/01-teardown-runbook.md) | Teardown A: delete → stub shell |
| 8 | [engineering/02-kill-list.md](./engineering/02-kill-list.md) | Routes, components, patterns banned forever |
| 9 | [04-interview-log.md](./04-interview-log.md) | Frozen discovery answers |

---

## Locked decisions (interview Round 1)

| ID | Decision |
|----|----------|
| D1 | Dual wedge: closed-loop fix **and** gateway+observe+improve |
| D2 | Primary user: solo AI eng debugging their agent tonight |
| D3 | Kill **red-team** surface in v1 (guardrails policies may remain — see Round 2) |
| D4 | Landing after login: **Dashboard** (agent-centric OS, Laminar energy) |
| D5 | UI north star: **Laminar** wholesale grammar |
| D6 | AI: dedicated **Agent page** + floating **clickable bubble** |
| D7 | PRs are a first-class Improve outcome (alongside artifacts, optimization) |
| D8 | Keep docs site + i18n; all other portal tech/design open to rewrite |
| D9 | Teardown mode **A**: delete app surfaces → stub shell + these docs until rebuild |
| D10 | Success = looks right, IA obvious, never “that looks wrong” |

### Must-ship surfaces (v1 product)

Traces · Sessions · Issues · Alerts · Evals · Improve (plans/artifacts/promote/PRs) · Guardrails\* · Cost · Agents · Audit · AI Agent (page+bubble) · Debugger sessions / replay / time-travel · Settings · Dashboard  

**Later:** Prompts registry · Analytics (users/tools/insights)

\*Red-team UI killed; guardrails policies TBD Round 2.

---

## Document contracts

Every surface spec in `surfaces/` MUST include:

1. Purpose (one decision the page owns)  
2. Primary user + JTBD  
3. URL + query grammar  
4. Layout diagram (desktop ≥1280 / tablet / mobile)  
5. Chrome budget (≤2 bands; ≤5 primary toolbar actions)  
6. States: empty / first-run / loading / error / filtered-empty / populated / live  
7. Components used (kit only)  
8. Keyboard map  
9. Closed-loop exits (where user goes next)  
10. Anti-patterns banned on this surface  
11. Acceptance checklist  

---

## Relationship to old plans

| Old artifact | Status |
|--------------|--------|
| `clients/portal/PORTAL_UI_OVERHAUL_PLAN.md` | Historical — incremental; do not execute |
| `clients/portal/PORTAL_OBSERVE_V3_PLAN.md` | Mine for URL grammar only; rewrite into `surfaces/traces.md` |
| `clients/portal/IMPROVE_V3_PLAN.md` | Mine for object names; rewrite into `surfaces/improve.md` |
| `clients/portal/DESIGN.md` | Superseded by `design/DESIGN-SYSTEM-V2.md` after cutover |
| `.cursor/visual-research/ai-portals/` | Evidence corpus — keep |

---

## Rebuild phases (engineering)

| Phase | Name | Outcome |
|-------|------|---------|
| P0 | Docs + teardown stub | This folder complete; portal is non-functional stub |
| P1 | Shell + design system | Auth, sidebar, header, kit, i18n, empty Dashboard |
| P2 | Agents + Dashboard | Agent-first home (Laminar) |
| P3 | Observe | Traces/Sessions/Issues/Alerts — transcript-first |
| P4 | Evaluate | Evals hub (datasets → playground → experiments) |
| P5 | Improve | Queue → artifact → PR; cost + guardrails |
| P6 | Agent AI + debugger | Dedicated page + bubble; debugger sessions |
| P7 | Workspace polish | Settings, audit, mobile QA, density pass |

---

## Change control

Amendments require: (1) update the relevant doc, (2) bump the “Decision date” or add a dated note in `04-interview-log.md`, (3) never silently diverge in code.  
Code that contradicts these docs is a bug.

---

## Inventory (as of 2026-07-21 teardown)

| Artifact | Evidence |
|----------|----------|
| Spec markdown files | **30** under `docs/portal-rebuild/` |
| Spec size | **~9,000 lines / ~55k words** |
| Surface contracts | **16 must-ship + 2 later stubs** in `surfaces/` |
| Teardown branch | `portal/teardown-stub-a` |
| Backup tag | `portal-pre-teardown-20260721` |
| Portal product UI | **Torn down** — stub shell only (`dashboard` + `/_stub/[surface]`) |
| Deletion delta | **~855 files / ~103k lines removed** from portal package |
| Gates | `bun run typecheck` ✅ · `bun run test` **128/128** ✅ |

**Implement:** [`PHASES.md`](./PHASES.md)  
**Understand:** [00-vision.md](./00-vision.md) → [02-information-architecture.md](./02-information-architecture.md) → [surfaces/_INDEX.md](./surfaces/_INDEX.md).
