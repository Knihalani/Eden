# Engineering overview — Portal greenfield rebuild

> **Status:** Authoritative for stack, package layout, data layer, flags, milestones.  
> **Parent:** [../README.md](../README.md)  
> **Teardown:** [01-teardown-runbook.md](./01-teardown-runbook.md)  
> **Banned forever:** [02-kill-list.md](./02-kill-list.md)  
> **Decision date:** 2026-07-21  

Code that contradicts these docs is a bug. Specs under `docs/portal-rebuild/` win over any `clients/portal/PORTAL_*.md` or `DESIGN.md`.

---

## 1. Goals

| ID | Goal |
|----|------|
| G1 | Tear down authenticated product UI (Teardown A). Leave a stub shell + Clerk + proxy + these docs until rebuild. |
| G2 | Rebuild product surfaces against Laminar UX grammar: density, transcript-first, agent-as-primary object. |
| G3 | Ship the dual wedge: **gateway + observe + improve** and **failure → fix artifact → PR**. |
| G4 | Primary user is a **solo AI eng debugging their agent tonight** — IA obvious in under 10 seconds after login. |
| G5 | Keep deploy identity: same package, same Clerk app, same env var names, same `/api/proxy` contract. |
| G6 | Preserve docs site redirect (`/docs` → docs.edenobservability.com), marketing route group, i18n (en/de). |
| G7 | Backend (Northflank FastAPI) is **out of scope** for teardown and for this overview’s deletion rules. |

Success criteria (product): look → “this looks good, I can use this”; never “that looks wrong.” See [../04-interview-log.md](../04-interview-log.md) D12.

---

## 2. Non-goals

| ID | Non-goal |
|----|----------|
| NG1 | Do **not** tear down FastAPI / Northflank / Tinybird / gateway. Portal UI only. |
| NG2 | Do **not** create `clients/portal-v2` (see §3). |
| NG3 | Do **not** delete `(marketing)`, auth routes, `/api/proxy`, Clerk middleware (`src/proxy.ts`), or `.env.example` patterns. |
| NG4 | Do **not** ship red-team UI in v1 (D3). Guardrails policies may return later without red-team pages. |
| NG5 | Do **not** resurrect hub-of-hubs, dual command palettes, or decorative Card grids (see kill list). |
| NG6 | Do **not** treat incremental overhaul plans (`PORTAL_UI_OVERHAUL_PLAN.md`, Observe/Improve v3 plans) as executable. Mine for URL grammar/object names only. |
| NG7 | Do **not** index authenticated product pages for search engines (keep `robots: { index: false }` on app shell). |
| NG8 | Prompts registry and Analytics (users/tools/insights) are **later** — not P0–P7 must-ship blockers. |

---

## 3. Target architecture (package decision)

### Recommendation: keep `clients/portal`, stub then grow

| Option | Verdict | Why |
|--------|---------|-----|
| **A. Keep `clients/portal`** | **RECOMMENDED** | Same Vercel project, Clerk keys, `NEXT_PUBLIC_API_URL=/api/proxy`, `API_INTERNAL_URL`, cookie same-origin hop, existing `src/proxy.ts` (Clerk + next-intl), e2e seeds, CI package path. |
| B. New `clients/portal-v2` | Reject for v1 | Forces Clerk rewiring, duplicate env, dual deploy, redirect matrix hell, weeks of infra debt before UI work. |

### Shape after teardown

```
clients/portal/
  src/
    app/
      layout.tsx              # KEEP — ClerkProvider, Geist, next-intl, globals.css
      globals.css             # KEEP tokens; redesign later via DESIGN-SYSTEM-V2
      (auth)/                 # KEEP
      sign-in/, sign-up/      # KEEP
      (marketing)/            # KEEP (or leave untouched)
      api/proxy/              # KEEP catch-all
      api/health/             # KEEP
      (portal)/
        layout.tsx            # STUB providers + minimal shell
        providers.tsx         # KEEP pattern (Auth/Org/Query)
        page → /dashboard     # RebuildInProgress OR Coming soon IA
        … deleted product pages
    components/
      ui/                     # KEEP primitives; restrip banned patterns later
      auth/                   # KEEP
      portal-chrome/          # REPLACE with stub sidebar (new IA labels)
    lib/
      api/, proxy.ts, …       # KEEP data-layer contracts
      sidebar-config.ts       # REPLACE with rebuild IA
    hooks/use-api-query.ts    # KEEP useOrgQuery
    i18n/, messages/          # KEEP skeleton (trim product strings as needed)
    proxy.ts                  # KEEP Clerk middleware
  .env.example                # KEEP
docs/portal-rebuild/          # AUTHORITATIVE specs (this tree)
```

Northflank FastAPI remains the source of truth for product data. Portal talks to it only through `/api/proxy/[...path]` (prod) or documented local bypass.

---

## 4. Stack decisions

Keep unless a dated amendment in `04-interview-log.md` overrides:

| Layer | Keep | Notes |
|-------|------|-------|
| Framework | Next.js 16 (App Router) | Already on package; RSC layouts + client islands. |
| UI | React 19 | |
| Styling | Tailwind v4 + `globals.css` tokens | Tokens migrate toward `design/DESIGN-SYSTEM-V2.md`; do not invent a second token system. |
| Fonts | Geist / Geist Mono | Already wired in `src/app/layout.tsx`. |
| Auth | Clerk (`@clerk/nextjs`) | `ClerkProvider`, sign-in/up, `src/proxy.ts` middleware. |
| Data | TanStack Query | Via `useOrgQuery` / `useApiQuery` / `useOrgMutation`. |
| i18n | next-intl | `src/i18n/*`, `src/messages/en.json`, `de.json`. |
| Primitives | Radix + local `components/ui/*` | Prefer kit primitives; ban ad-hoc modal stacks. |
| Icons | lucide-react + `components/icons/eden-nav-icons` | One icon language per surface. |
| Unit | Vitest | Contract tests for IA, redirects, kill-list presence. |
| E2E | Playwright | Golden paths **after** shell is real (P1+); stub phase = smoke only. |

Do **not** add a second state library, second design kit, or CSS-in-JS for the rebuild unless the design-system doc explicitly requires it.

---

## 5. Folder conventions (rebuild)

### App Router

| Path | Role |
|------|------|
| `src/app/(portal)/` | Authenticated product only. |
| `src/app/(portal)/<surface>/page.tsx` | One primary page per must-ship surface. |
| `src/app/(portal)/<surface>/_components/` | Surface-private UI (not shared chrome). |
| `src/app/(portal)/<surface>/__tests__/` | Vitest contracts for that surface. |
| `src/app/(marketing)/` | Public marketing/legal — out of rebuild delete scope. |
| `src/app/(auth)/`, `sign-in/`, `sign-up/` | Auth — preserve. |
| `src/app/api/proxy/[...path]/` | Canonical BFF to FastAPI — preserve. |

### Components

| Path | Role |
|------|------|
| `src/components/ui/` | Design-system primitives only. |
| `src/components/shell/` (new) | App shell, sidebar, header, density — replace `portal-chrome` / `portal-os` gradually. |
| `src/components/<domain>/` | Domain widgets (traces, improve, …) owned by surface specs. |
| **Banned dirs to delete in teardown** | See runbook: `portal-os` hub shells, old hub wrappers, `EmbeddedSurface` consumers. |

### Lib / hooks

| Path | Role |
|------|------|
| `src/lib/api/core.ts` + domain modules | `fetchApi`, `ApiError`, typed resources. |
| `src/lib/query-keys.ts` | Stable TanStack keys. |
| `src/hooks/use-api-query.ts` | `useOrgQuery` / `useApiQuery` / `useOrgMutation`. |
| `src/lib/sidebar-config.ts` | Single source of nav IA (contract-tested). |
| `src/lib/portal-routes.ts` | Known / removed path prefixes. |

### Specs (not code)

| Path | Role |
|------|------|
| `docs/portal-rebuild/surfaces/*.md` | Per-surface must-ship contract. |
| `docs/portal-rebuild/design/DESIGN-SYSTEM-V2.md` | Tokens, chrome budget, density. |
| `docs/portal-rebuild/engineering/*` | This folder. |

**Rule:** One decision per page. No nesting another full product surface inside a hub via `EmbeddedSurface`.

---

## 6. Data layer conventions

### Canonical path

```
Browser → fetchApi (NEXT_PUBLIC_API_URL, prod = /api/proxy)
       → src/app/api/proxy/[...path]/route.ts
       → API_INTERNAL_URL (FastAPI on Northflank)
```

| Symbol | Location | Rule |
|--------|----------|------|
| `fetchApi` | `src/lib/api/core.ts` | Only browser/server client entry for JSON APIs. No raw `fetch('/api/…')` for org product data except documented exceptions (SSE, uploads). |
| `useOrgQuery` | `src/hooks/use-api-query.ts` | Default for org-scoped reads. Disabled when `orgId` falsy. |
| `useApiQuery` | same | Non-org reads. |
| `useOrgMutation` | same | Writes + `invalidateKeys`. |
| `queryKeys.*` | `src/lib/query-keys.ts` | All keys must go through this module. |
| `/api/proxy/[...path]` | App Router | Preserve circuit breaker, auth forwarding, SSE behavior covered by existing proxy tests. |
| `/api/health` | Public | Uptime / auth-card badge — keep. |

### Forbidden data patterns

- Calling FastAPI absolute URL from the browser in production (cookie / CORS breakage).
- Parallel “legacy” axios/fetch wrappers beside `fetchApi`.
- Org queries that run with `enabled: true` when `orgId` is null.
- Page-local `useEffect` + `setState` for primary list/detail loads (use TQ).

### Env (do not rename casually)

From `clients/portal/.env.example`:

- `NEXT_PUBLIC_API_URL` — prod must be `/api/proxy`
- `API_INTERNAL_URL` — absolute FastAPI upstream for the proxy route
- Clerk `NEXT_PUBLIC_CLERK_*` / `CLERK_SECRET_KEY` pair from the same instance

---

## 7. Feature flags / stub mode

### Stub mode (P0)

After teardown, authenticated product is intentionally non-functional for product work:

| Mechanism | Purpose |
|-----------|---------|
| `PORTAL_REBUILD_STUB=1` (or `NEXT_PUBLIC_PORTAL_REBUILD_STUB=1`) | Client+server flag: show RebuildInProgress / Coming soon; hide live data widgets. |
| Stub shell sidebar | Labels match **target** IA (Dashboard, Agents, Traces, Sessions, Issues, Alerts, Evals, Improve, Cost, Guardrails, Audit, Settings, AI Agent) — links to Coming soon placeholders until surface lands. |
| Single landing | Post-login → `/dashboard` (D4) showing rebuild banner + link to `docs/portal-rebuild/README.md`. |

Flag may be compile-time env or a tiny `src/lib/rebuild-stub.ts` helper. Document the chosen name in the teardown PR.

### Feature flags during rebuild (P1+)

| Flag pattern | Use |
|--------------|-----|
| Per-surface `NEXT_PUBLIC_SURFACE_<NAME>=1` | Optional dark-launch of a rebuilt surface behind stub. Prefer shipping to stub replacement over long dual-UI. |
| Server/backend flags | Unchanged; portal must not invent UI for disabled Improve if API returns feature-disabled (reuse honest empty/disabled states from design system). |

**Rule:** Stub mode is binary for chrome. Do not leave half of old `portal-chrome` and half of new shell mounted together.

---

## 8. Phase milestones P0–P7

Aligned with [../README.md](../README.md) rebuild phases. Exit criteria are **gate** — do not start the next phase until the previous exit checklist is green.

### P0 — Docs + teardown stub

| Exit criterion | Evidence |
|----------------|----------|
| Spec folder complete enough to execute teardown | `docs/portal-rebuild/` README + engineering trio present |
| Authenticated product pages deleted / redirected | Runbook verification checklist |
| Stub shell ships | Signed-in user sees rebuild shell, not old hubs |
| Auth + proxy + marketing still work | Smoke: sign-in, `/api/health`, marketing `/`, docs redirect |
| Old UI tests archived or deleted | CI green on remaining suite |
| FastAPI untouched | No backend deploy required for P0 |

### P1 — Shell + design system

| Exit criterion | Evidence |
|----------------|----------|
| New shell: sidebar, header, density, ≤2 chrome bands | Matches DESIGN-SYSTEM-V2 chrome budget |
| Kit primitives documented and used for empty Dashboard | No Card-grid marketing home |
| i18n strings for shell + stub | en (+ de skeleton) |
| Empty Dashboard lands post-login | D4 |
| Vitest IA contract: sidebar ids/hrefs match `02-information-architecture.md` | Contract file green |

### P2 — Agents + Dashboard

| Exit criterion | Evidence |
|----------------|----------|
| Agent-first home (Laminar energy) | Surface spec acceptance |
| Agents list/detail usable for tonight’s debug loop | Solo-eng JTBD |
| Cross-links to Observe/Improve exist without hub nesting | Kill-list clean |

### P3 — Observe

| Exit criterion | Evidence |
|----------------|----------|
| Traces, Sessions, Issues, Alerts — transcript-first | Surface specs |
| No `TraceViewerModal` as primary path | Kill list |
| Deep links use URL grammar from IA doc | Contract tests |

### P4 — Evaluate

| Exit criterion | Evidence |
|----------------|----------|
| Evals hub: datasets → playground → experiments | One hub, tab/mode grammar — not four top-level nav items |
| Old top-level `/playgrounds`, `/experiments`, `/datasets` stay redirects only | `next.config.ts` |

### P5 — Improve

| Exit criterion | Evidence |
|----------------|----------|
| Queue → artifact → PR loop visible | Product bible closed-loop grammar |
| Cost + Guardrails (policies, **no** red-team) | D3 |
| PRs first-class Improve outcome | D7 |

### P6 — Agent AI + debugger

| Exit criterion | Evidence |
|----------------|----------|
| Dedicated AI Agent page + floating clickable bubble | D6 |
| Debugger sessions / replay / time-travel reachable without resurrecting `/observability/*` hubs | Redirects + new routes per IA |

### P7 — Workspace polish

| Exit criterion | Evidence |
|----------------|----------|
| Settings, Audit | Must-ship list |
| Mobile QA pass | Interview pain: adaptation failure |
| Density pass vs Laminar reference | Visual QA |
| Definition of Done (§10) satisfied | Sign-off |

---

## 9. Testing strategy

### During stub (P0)

| Layer | Action |
|-------|--------|
| Vitest | Keep: proxy, auth helpers, `fetchApi` retry/circuit, route-prefix helpers. Delete/archive tests that assert old page DOM, hub copy, EmbeddedSurface, wave-* UI freezes. |
| Playwright | Minimal smoke: load `/sign-in`, authenticated hit `/dashboard` stub, `/api/health` 200. Quarantine `e2e/golden` product flows until P3+. |
| Lint scripts | `lint:portal-clutter` / layout lints may need stub allowlists — update rather than disable forever. |

### Rebuild (P1+)

| Layer | What |
|-------|------|
| **Vitest IA contracts** | Assert sidebar groups, banned hrefs, redirect table, kill-list greps (no `EmbeddedSurface`, single CommandPalette path, no `/redteam` page). |
| **Vitest surface contracts** | Per `surfaces/*.md` acceptance bullets that are static (URL grammar, chrome budget constants). |
| **Playwright golden** | Reintroduce after Observe (P3): login → dashboard → open trace → issue → improve handoff. |
| **Visual smoke** | Optional capture vs Laminar-inspired fixtures; not a P0 gate. |

### Contract test locations (suggested)

```
clients/portal/src/app/(portal)/__tests__/rebuild-ia.contract.test.ts
clients/portal/src/lib/__tests__/rebuild-kill-list.contract.test.ts
```

These replace the wave-numbered freeze tests (`w1-…`, `ws12-freeze`, etc.) as those surfaces are deleted.

---

## 10. Definition of done (rebuild)

The greenfield rebuild is **done** when all of the following hold:

1. **IA:** Post-login Dashboard; nav matches information-architecture doc; core nav ≤ budget; no hub-of-hubs.
2. **Must-ship surfaces live** (from README): Traces · Sessions · Issues · Alerts · Evals · Improve (plans/artifacts/promote/PRs) · Guardrails (no red-team) · Cost · Agents · Audit · AI Agent (page+bubble) · Debugger sessions/replay/time-travel · Settings · Dashboard.
3. **Closed loop:** From a failure (issue/trace), user can reach a fix artifact and a PR suggestion without dead ends.
4. **Kill list clean:** CI contract fails if banned routes/components reappear as top-level product UI.
5. **Stack:** Still `clients/portal` + Clerk + `/api/proxy` + next-intl; no portal-v2 fork.
6. **Quality bar:** Solo eng can complete “debug my agent tonight” without thinking the UI looks wrong; mobile not broken for primary five destinations.
7. **Docs:** Surface specs’ acceptance checklists checked; interview log not contradicted without dated amendment.
8. **Backend:** No requirement that FastAPI was rewritten for the UI rebuild to claim done.

### Sign-off (Phase 7)

| Field | Value |
|-------|--------|
| **Date** | 2026-07-22 |
| **Branch** | `portal/phase-1-shell` |
| **Gates** | `cd clients/portal && bun run typecheck && bun run test` — **365/365** tests, typecheck clean |
| **Contracts** | `rebuild-ia`, `rebuild-kill-list`, `rebuild-phase7`, surface contracts for all must-ships |
| **Golden** | `e2e/golden/agent11-phase7-probe.mjs` (auth soft-skip without `e2e/.auth-state.json`) |
| **Verdict** | Rebuild DoD §10 **satisfied** — all 12 IA leaves live; Later Prompts/Analytics stay soft-landed. |

---

## 11. Related artifacts

| Artifact | Role |
|----------|------|
| [01-teardown-runbook.md](./01-teardown-runbook.md) | Executable delete → stub |
| [02-kill-list.md](./02-kill-list.md) | Never resurrect |
| [../00-vision.md](../00-vision.md) | Vision |
| [../02-information-architecture.md](../02-information-architecture.md) | Target nav/URLs |
| [../design/DESIGN-SYSTEM-V2.md](../design/DESIGN-SYSTEM-V2.md) | Visual system |
| `clients/portal/.env.example` | Env contract |
| `clients/portal/src/proxy.ts` | Clerk + i18n middleware |
| `clients/portal/src/app/api/proxy/[...path]/route.ts` | BFF |

---

## Change control

Amend stack, package, or milestone gates only by: (1) editing this file, (2) dated note in `04-interview-log.md`, (3) PR description linking the amendment. Silent divergence in code is a bug.
