# Portal UX Changelog — Home + Shell (Waves 0–11)

**Scope:** Authenticated portal Home (`/dashboard`) + global shell chrome (sidebar, header/⌘K, Ask AI, cookies, buttons, bottom exclusivity).  
**Freeze date:** 2026-07-21 · Plan: `home_shell_fleet_1fa2322b` · Signoff: [`.home-shell-w10-signoff.md`](./.home-shell-w10-signoff.md) · Freeze: [`.home-shell-w11-freeze.md`](./.home-shell-w11-freeze.md)  
**Verdict:** **SHIP** — Cookie 2A · Ask AI 1A · Helicone-restraint Home · chrome ≤400.

### Locked decisions

| Decision | Choice |
|----------|--------|
| Ask AI | **1A** — header icon + redesigned FAB + ⌘K/⌘J → one surface |
| Cookies | **2A** — hide after Accept/Decline; Settings / Privacy / footer reopen only |
| Home | Status → Diagnosis → one Action; KPI strip ≤4; no widget editor |

### What shipped (Home + Shell)

| Wave | Theme | Shipped |
|------|-------|---------|
| 0 | Research | Competitor shell patterns; clutter / protect inventory |
| 1 | Contracts | DESIGN 1A/2A; `w13-home-shell-contracts` reopen |
| 2 | Cookies | Banner then **null**; Settings + footer reopen; offset cleared |
| 3 | Ask AI | Header icon + redesigned FAB + palette / ⌘J; coach tip once |
| 4 | Sidebar | Tonal rail; core ≤12; Advanced collapsed; **SidebarSearch deleted** |
| 5 | Header + ⌘K | Slim `h-11`; kit breadcrumbs; visible **Search… ⌘K** chip |
| 6 | Buttons | Kit `Button` on Home path; IconButton = `size="icon"` |
| 7 | Home UI | Composition rebuild; dead widgets removed; quiet links |
| 8 | States | First-run / empty / error / loading; a11y landmarks |
| 9 | Mobile + z | FAB / mobile nav / cookie exclusivity; safe areas |
| 10 | QA | SHIP signoff; path-contract evidence (live PNG/axe deferred) |
| 11 | Freeze | Docs; freeze protect; orphan kill; LOC gate; Open Traces ghost |

### Freeze artifacts

| Artifact | Path |
|----------|------|
| W10 signoff | `.home-shell-w10-signoff.md` |
| W11 freeze | `.home-shell-w11-freeze.md` |
| Freeze tests | `src/app/(portal)/__tests__/w13-home-shell-contracts.test.ts` |
| Walkthrough | `WALKTHROUGH-UX.md` (§ Home + Shell) |
| Route matrix | `.wave12-route-matrix.md` (Home Shell W10 row) |

### Do not reopen

Cookie always-on pill · quiet-only Ask AI · Home widget editor · Settings double sidebar · unused `SidebarSearch` · KPI card collage on Home.

---

# Portal UX Changelog — Improve V3 (Waves 0–11)

**Scope:** Improve group — `/improve` (+ plans/runs), `/artifacts`, `/ledger`, `/prompts`, Advanced: scorecard / online-scoring / change-impact / `/guardrails` / `/optimization`.  
**Freeze date:** 2026-07-21 · Plan: `improve_v3_fleet_cdd87ca0` · IA: [`IMPROVE_V3_PLAN.md`](./IMPROVE_V3_PLAN.md)  
**Verdict:** **SHIP** — Prompts→core; Queue master–detail hub ≤400; Evaluate stays separate.

### IA (locked)

Improve = **act** (queue → ship → remember). Core: Queue · Plans (tab) · Artifacts · Ledger · **Prompts**. Advanced: Scorecard · Online scoring · Change impact · Guardrails · Cost. Evaluate (`/evals` datasets / playgrounds / experiments) is **not** merged.

### What shipped (Improve V3)

| Wave | Theme | Shipped |
|------|-------|---------|
| 0 | Research + IA | `IMPROVE_V3_PLAN.md` signed; Prompts→core YES; Evaluate merge NO |
| 1 | Nav | Sidebar + ⌘K; related strip Issues · Artifacts · Ledger · Prompts |
| 2 | Queue hub | Master–detail + ViewsMenu; shell peel ≤400; RQ unify |
| 3 | Plans | Diff/Summary; kit Dialogs; toast honesty |
| 4 | Artifacts + Ledger | Evidence-gated promote; promotions as Ledger mode |
| 5 | Prompts | Lifecycle master–detail; playground deep-link (Evaluate stays home) |
| 6 | Guardrails | Promptfoo-style report drill; queue bridge |
| 7 | Cost | KPI strip + Model Advisor; Outcomes StatCard soup killed |
| 8 | Advanced leaves | Scorecard / online-scoring / change-impact polish |
| 9 | Cross-loop | Deep links, empties, onboarding, walkthrough |
| 10 | Verify | Axe serious=0 Improve-group; LOC; E2E loop; verifier |
| 11 | Freeze | Route matrix IV3 re-sign; CHANGELOG/DESIGN; freeze vitest; SHIP critic |

### Freeze artifacts

| Artifact | Path |
|----------|------|
| Final critic | `.wave11-improve-final-critic.md` |
| Verifier (W10) | `.wave10-improve-verifier.md` |
| Route matrix | `.wave12-route-matrix.md` (Improve V3 note + IV3 rows) |
| Freeze tests | `src/app/(portal)/__tests__/w11-improve-v3-freeze.test.ts` |
| Visual baselines | `e2e/golden/w12-visual-baselines.md` (§ Improve V3) |

### Do not reopen

Evaluate hub redesign · new brand accents / glow / pill clusters · kanban-only queue walls · Prompts demotion to Advanced.

---

# Portal UX Changelog — Observe V3 (Waves 0–9)

**Scope:** Authenticated Observe surfaces (`/traces`, `/issues`, `/alerts` + advanced embeds).  
**Freeze date:** 2026-07-21 · Plan: `PORTAL_OBSERVE_V3_PLAN.md` · Gap: `.wave-v3-0-gaps.md`  
**Verdict:** **SHIP** — 8/8 Wave 0 P0s addressed; dual IA / always-on Live remain frozen.

### What shipped (V3)

| Wave | Theme | Shipped |
|------|-------|---------|
| 0 | Research | Competitor gap matrix; P0 adopt list locked |
| 1 | Spec | Observe interaction contract + DESIGN delta |
| 2 | Hub chrome | Display first-class; `pastHours`→query; URL dialect; I/O cols; built-in views |
| 3 | Trace reader | Tree tokens/cost; inspector; failure callout; `?spanId=` write-back |
| 4 | Timeline + Sessions | Bidirectional Gantt sync; zoom/brush; session turn cards `1/N` |
| 5 | Issues + Alerts | Evidence peek; cross-link `TracePreserveParams` |
| 6 | Loop + keyboard | Dataset/playground CTAs; citation chips; j/k Enter Esc ⌘K; core signoff |
| 7 | Advanced | Agents / Analytics / Debug density |
| 8 | Power shells | Replay / Query / Inspector ≤400; Overflow-only |
| 9 | Freeze | Clutter traces≤8; vitest 166; CHANGELOG; freeze pack |

### Freeze artifacts (V3)

| Artifact | Path |
|----------|------|
| Freeze | `.wave-v3-9-freeze.md` |
| Route matrix | `.wave-v3-9-route-matrix.md` |
| Open questions | `.wave-v3-9-open-questions.md` |
| Core signoff | `.wave-v3-6-core-signoff.md` |

### Gates (Wave 9)

- Traces toolbar primary ≤8 — **pass** (5 markers)
- Focused vitest Observe suite — **166 passed / 18 files**
- Fresh axe — **blocked** (no `:3000`); prior auth reports serious=0 — residual in `.wave-v3-9-open-questions.md`

### Do not reopen

Dual `/observability` hub · Live always-on primary · DESIGN purple/glow/pill chrome · Evaluate/Improve redesign.

---

# Portal UX Changelog — UI Overhaul V2 (Waves 0–12)

**Scope:** Authenticated Eden portal (`clients/portal`) only.  
**Freeze date:** 2026-07-21 · Plan: `portal_ui_overhaul_v2_29d962b2`

## Summary

Leaf-first rewrite of every portal page and shared reader toward Laminar-class usable polish: one decision per page, ≤2 chrome bands, transcript-first traces, master–detail lists, settings ≤8 default tabs, and CI gates that keep toolbar / Badge / nested-hub clutter from regressing. V1 Waves 1–12 treated as scaffolding (~25–30% polish); V2 Waves 1–11 rewrote content; Wave 12 freezes gates + signoff.

## By wave (V2)

| Wave | Theme | What shipped |
|------|-------|--------------|
| 0 | Research | Peer grammar + 78 PNGs + 15 MUST checklist |
| 1 | Kit + OS | Button / Badge / PageHeader / FilterBar / Empty freeze |
| 2 | Transcript | Single stack; Laminar numeric contracts |
| 3 | Traces hub | Toolbar ≤8; columns; sessions |
| 4 | Guardrails + Alerts | Leaf rewrites + LOC splits |
| 5 | Issues | List + detail declutter |
| 6 | Analytics | Thin embeds; kill full-app embeds |
| 7 | Improve | Queue / artifacts / ledger loop |
| 8 | Evaluate | Hub + datasets / playgrounds / experiments |
| 9 | Settings + Prompts + Cost | Flatten tabs; kill double sidebar |
| 10 | Agents + Observe power | Table defaults; Overflow slim shells |
| 11 | Home + Auth + OS | Protect Home; auth consistency; chrome ≤400 |
| 12 | Freeze | DESIGN drift, clutter/Badge lint, baselines, E2E loop, axe gate, 75-route matrix, critic |

## User-visible behavior

- **Home** answers “is the fleet healthy?” then one next action.
- **Traces** triage first; Live / legacy tools in More; Transcript default.
- **Issues / Alerts** keep list while opening detail (split or drawer).
- **Evals** = datasets → playgrounds → experiments; studio/synthetic in Advanced.
- **Improve** = act on queue → artifacts → ledger / promote.
- **Settings** category pills; Advanced holds gateway / PII / retention / exports.
- **Density** Comfortable (default) / Compact in Settings.

## Engineering gates

```bash
bun run lint:portal-clutter   # toolbar ≤5 / traces ≤8 / nested EmbeddedSurface / Badge grammar
bun run lint:portal-classes   # micro-text / half-step / accent-cta ratchets
bun run polish:check          # hex / dead CSS / layout + above
bun run test -- src/app/\(portal\)/__tests__/w12-freeze.test.ts
bun run test:e2e-loop         # dry-run contract; W12_E2E_LIVE=1 for Playwright
bun run audit:a11y            # serious=0 on /traces /improve /evals /issues (needs server + auth)
```

## Freeze artifacts

| Artifact | Path |
|----------|------|
| DESIGN drift | `.wave12-design-drift.md` |
| Open questions | `.wave12-open-questions.md` |
| Final critic | `.wave12-final-critic.md` |
| 75-route matrix | `.wave12-route-matrix.md` |
| Visual baselines | `e2e/golden/w12-visual-baselines.md` |
| E2E loop | `e2e/golden/w12-observe-eval-improve.mjs` |
| Walkthrough | `WALKTHROUGH-UX.md` |

## Intentional debt

See `.wave12-open-questions.md` and `.wave12-final-critic.md` — notably Improve ~714 / Settings ~647 LOC and dense Observe shells.

---

## Workspace (Ambition A + Ghosts A · Wave 12 freeze)

**Freeze date:** 2026-07-21 · Fleet overhaul Waves 1–12 · Settings hub shell now **398 LOC** (≤400).

### What shipped

- Workspace overview as default Settings landing; daily tabs ≤6; Advanced collapsed.
- Unified compliance URL `/audit-trail` (`?tab=audit-log` redirects); mobile More Workspace = Audit · Settings · API keys.
- Personal vs team mode helpers; Roles/SSO soft-hidden (Ghosts A — quiet deep-link only).
- Freeze pack: `ws12-freeze.test.ts` + `.workspace-wave12-*` artifacts.

### Freeze artifacts

| Artifact | Path |
|----------|------|
| Freeze test | `src/app/(portal)/settings/__tests__/ws12-freeze.test.ts` |
| Route matrix | `.workspace-wave12-route-matrix.md` |
| Axe evidence | `.workspace-wave12-axe-evidence.md` |
| DESIGN drift | `.workspace-wave12-design-drift.md` |
| Final critic | `.workspace-wave12-final-critic.md` |
| Open questions | `.workspace-wave12-open-questions.md` |
| Signoff | `.workspace-wave12-signoff.md` |
| Verifier | `.workspace-wave12-verifier.md` |

### Intentional Workspace debt

Live axe on `/settings` + `/audit-trail` deferred; leaf LOC peel (account/keys/security); loading skeleton 240px residual. See `.workspace-wave12-open-questions.md`.

## Workspace Section Overhaul (2026-07-21)

Full productize of Workspace pillar (Ambition A) with Roles/SSO soft-hidden (Ghosts A).

| Wave | Theme | Shipped |
|------|-------|---------|
| 0 | Research | `.workspace-research-wave0.md` + R1–R10 |
| 1 | IA + shell | Registry, overview default, mobile IA match, audit-log redirect, shell ≤400 path |
| 2 | Overview + copy | Overview composition, personal chrome, workspace wording |
| 3 | Org + Account | Stripe-class leaves + markers |
| 4 | Members + Security | Invite gates, 2FA clarity |
| 5 | Keys + Billing | Reveal-once keys, plan card |
| 6 | Audit unify | `/audit-trail` Events \| Chain packs |
| 7 | Advanced data | Gateway/PII/retention/exports/DLQ |
| 8 | Advanced ops | MCP/SCIM/… + legacy settings re-exports |
| 9 | Shell hygiene | LOC ≤400, ⌘K parity |
| 10–12 | A11y + freeze | Contracts, route matrix, success metrics |

See `.workspace-wave12-final-critic.md`.

## Evaluate V3 (Waves E0–E7 · 2026-07-21)

**Scope:** Evaluate hub + leaves — `/evals` (Datasets · Playground · Experiments · Advanced), closed loop from Observe, reuse-only APIs.  
**Freeze date:** 2026-07-21 · Research: [`.research-evals-v3.md`](./.research-evals-v3.md) · Harden critic: [`.wave-e6-critic.md`](./.wave-e6-critic.md)  
**Verdict:** **SHIP** — 3-tab IA; Observe→dataset→experiment loop; compare OS; Advanced quiet; harden contracts. Live axe / live E2E deferred as intentional debt.

### What shipped

- **IA** — Hub = Datasets · Playground · Experiments; Advanced = Scores / Labeling / Studio / Synthetic (no nested PageHeader when embedded).
- **Closed loop** — Trace **Add to dataset** (single + batch) → land on Evaluate datasets; Issue → experiment primary; fromSpan + “From production” chip.
- **Datasets curate** — ≤1 Create; single search; saved views; **Start experiment** solid primary on detail.
- **Playgrounds promote** — solid **Run**; fail-first case×variant matrix; dataset bind before Promote; land compare-ready on Experiments.
- **Experiments compare OS** — persistent baseline + Δ colors; Diff mode + char-diff; Improve/Regress/Tradeoff/Tie grades; Summary \| List \| Grid (default Grid failing-first).
- **Advanced polish** — thin Scores; Labeling push-to-dataset + hotkeys; Studio declutter; Synthetic honest deferred history.
- **Harden** — `failuresOnly=1`; diff side-rail; keyboard/mobile/perf markers; E2E dry contracts; shell LOC ≤400.

### By wave (E0–E7)

| Wave | Theme | Shipped |
|------|-------|---------|
| E0 | Research | `.research-evals-v3.md` + 15 MUST; evals-v3 visual corpus |
| E1 | Closed loop | Hub IA truth; Trace batch Add to dataset; embed/empty/⌘K hygiene |
| E2 | Datasets | Curate OS; Start experiment; kill dual search; saved views |
| E3 | Playgrounds | Run hierarchy; fromSpan chip; Promote → compare-ready; fail-first matrix |
| E4 | Experiments | Baseline · Diff · grades · layouts · matrix |
| E5 | Advanced | Scores / Labeling / Studio / Synthetic polish + embed contract |
| E6 | Harden | Failures filter; diff rail; keyboard/mobile/perf; axe/E2E contracts; LOC |
| E7 | Freeze | Route matrix · DESIGN drift · final critic · CHANGELOG/WALKTHROUGH · visual note |

### Freeze artifacts

| Artifact | Path |
|----------|------|
| Route matrix | `.wave-e7-route-matrix.md` |
| DESIGN drift | `.wave-e7-design-drift.md` |
| Final critic | `.wave-e7-final-critic.md` |
| Visual baselines | `e2e/golden/w-e7-visual-baselines.md` (+ W12 `05-playgrounds` / `07-experiments`; peer law `.cursor/visual-research/evals-v3/`) — live PNG refresh deferred (Clerk key/session mismatch this freeze) |
| Critics E0–E6 | `.wave-e0-critic.md` … `.wave-e6-critic.md` |
| Research pack | `.research-evals-v3.md` |
| Walkthrough | `WALKTHROUGH-UX.md` (§ Evaluate V3) |

### Intentional debt

| Debt | Notes |
|------|-------|
| Live axe on `/evals` | Deferred — E7 started portal `:3000` but Clerk session refresh loop (stale `e2e/.auth-state.json` / key mismatch); product chrome not audited. Re-seed auth then `bun run audit:a11y` |
| Live E2E smoke | Deferred — E7 agent09 live hop timed out on `/evals` (same Clerk loop); dry `E6_PROBE_DRY=1` still exit 0 |
| Labeling push-to-dataset | Soft — still `window.prompt` for dataset id |
| Scores unused APIs | Soft — `evalApi` HIL / pairwise / CLHF / multimodal unused |
| Synthetic history | Soft — honest deferred until API persists runs |
| InfiniteDataTable mobile | Soft — `data-wave11-mobile="cards"` marker; true card-stack may be kit-level |

### Engineering gates (Evaluate)

```bash
# Wave contracts (56 tests across E1–E6 suites)
bun run test -- src/app/\(portal\)/evals/__tests__/wE1-closed-loop.test.ts
bun run test -- src/app/\(portal\)/datasets/__tests__/wE2-datasets.test.ts
bun run test -- src/app/\(portal\)/playgrounds/__tests__/wE3-playgrounds.test.ts
bun run test -- src/app/\(portal\)/experiments/__tests__/wE4-experiments-compare.test.ts
bun run test -- src/app/\(portal\)/evals/__tests__/wE5-advanced.test.ts
bun run test -- src/app/\(portal\)/evals/__tests__/wE6-harden.test.ts

# Shared freeze / a11y / loop (needs server + healthy seed-auth for live)
bun run lint:portal-classes   # Evaluate half-steps ratcheted; OK 112/112
bun run lint:portal-clutter   # Evaluate tablist cleared; portal-wide residual outside Evaluate
bun run polish:check          # portal-wide dead `--node-*` tokens (not Evaluate)
bun run test:e2e-loop         # dry-run; live hop when auth + portal up
bun run audit:a11y            # serious=0 on /evals (needs server + re-seeded auth)
```

### Do not reopen

New Evaluate backend endpoints · merge Evaluate into Improve · dual search on datasets · nested PageHeader on embedded leaves · invent `/compare/grades` API.
