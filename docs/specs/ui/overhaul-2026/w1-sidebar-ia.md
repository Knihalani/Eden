<!-- Auto-captured from Wave 1 agent `w1-sidebar-ia` (read-only discovery). -->

# W1 Sidebar IA Map — vs U12

**Source of truth:** `clients/portal/src/lib/sidebar-config.ts`  
**Route registry:** `clients/portal/src/lib/portal-routes.ts` (no separate `route-registry` file)  
**Spec:** `docs/specs/ui/u12-portal-ia.md` (status: PARTIAL)

---

## 1. Full nav tree — core vs Advanced

**`CORE_NAV_ITEM_COUNT` = 12** (top-level only; children excluded) — `sidebar-config.ts:268-271`  
**Groups / items:** `DEFAULT_SIDEBAR` `sidebar-config.ts:65-253`

| Group `id` → label | Item | href | category | Lines |
|---|---|---|---|---|
| **build → Home** | Home | `/dashboard` | core | `67-77` |
| **observe → Observe** | Traces | `/traces` | core | `80-89` |
| | Agent Issues | `/issues` | core | `90-96` |
| | Alerts | `/alerts` | core | `97-103` |
| | Agents | `/agents` | **advanced** | `104-111` |
| | Analytics | `/analytics` | **advanced** | `112-119` |
| | Signals | `/alerts?tab=signals` | **advanced** | `120-127` |
| | Debug sessions | `/debugger-sessions` | **advanced** | `128-135` |
| **automate → Evaluate** | Evals | `/evals` | core | `139-149` |
| **optimize → Improve** | Improve | `/improve` | core | `152-161` |
| | Artifacts | `/artifacts` | core | `162-168` |
| | Ledger | `/ledger` | core | `169-175` |
| | Promotions | `/promotions` | core | `176-182` |
| | Cost | `/optimization` | **advanced** | `183-190` |
| | Guardrails | `/guardrails` | **advanced** | `191-198` |
| | Prompts | `/prompts` | **advanced** | `199-206` |
| **workspace → Workspace** | Audit trail | `/audit-trail` | core | `210-219` |
| | Settings | `/settings` | core | `220-243` |
| | └ API keys | `/settings?tab=api-keys` | core (child) | `227-233` |
| | └ Webhook DLQ | `/settings/webhooks-dlq` | **advanced** (child) | `234-241` |
| | Quickstart | external docs URL | core | `244-250` |

**Counts**
| Bucket | Count | Notes |
|---|---|---|
| Core top-level | **12** | Matches `CORE_NAV_ITEM_COUNT` |
| Advanced top-level | **7** | agents, analytics, signals, debugger-sessions, Cost, Guardrails, Prompts |
| Advanced nested | **1** | Webhook DLQ |
| Core nested (uncounted) | **1** | API keys |
| Visible default (Advanced collapsed) | **12** top-level | + Settings children if expanded in UI |
| Visible expanded | **19** top-level | + both Settings children |

---

## 2. Group id vs label mismatches (build / automate / optimize)

| Group `id` | Display `label` | Mismatch? | Refs |
|---|---|---|---|
| `build` | **Home** | YES — id ≠ label | `sidebar-config.ts:67-68`; `GROUP_LABEL` `nav-commands.ts:19-20` |
| `observe` | Observe | no | `80-81`; `nav-commands.ts:21` |
| `automate` | **Evaluate** | YES | `139-140`; `nav-commands.ts:23` |
| `optimize` | **Improve** | YES | `152-153`; `nav-commands.ts:22` |
| `workspace` | Workspace | no | `210-211`; `nav-commands.ts:24` |

Default group order (product path): `["build","observe","automate","optimize","workspace"]` — `use-sidebar-prefs.ts:38-39`

Stale comment still says “Build / Observe / Optimize / Automate”: `sidebar-search.tsx:12-13`

---

## 3. Icon collisions

**Live code (2026-07-20): ZERO icon collisions.** Every sidebar leaf/child uses a distinct icon component.

| Item | Icon | Lines |
|---|---|---|
| Home | `LayoutDashboard` | `74` |
| Traces | `TraceIcon` | `87` |
| Agent Issues | `ShieldAlert` | `94` |
| Alerts | `AlertNavIcon` | `101` |
| Agents | `AgentIcon` | `108` |
| Analytics | `InsightsIcon` | `116` |
| Signals | `Radio` | `124` |
| Debug sessions | `Bug` | `132` |
| Evals | `EvalIcon` | `146` |
| Improve | `PatchIcon` | `159` |
| Artifacts | `Package` | `166` |
| Ledger | `BookOpen` | `173` |
| Promotions | `TrendingUp` | `180` |
| Cost | `CostIcon` | `187` |
| Guardrails | `GuardrailIcon` | `195` |
| Prompts | `FileCode` | `203` |
| Audit trail | `ShieldCheck` | `217` |
| Settings | `Settings` | `224` |
| API keys | `KeyRound` | `231` |
| Webhook DLQ | `Inbox` | `238` |
| Quickstart | `FileText` | `248` |

### SUPERSEDED — prior collision table (stale)

> The following collision sets were true in an earlier Wave 1 snapshot and are **no longer present** in `sidebar-config.ts`. Do not cite them as current.

| Icon (old) | Colliding items (old) | Status |
|---|---|---|
| `AlertNavIcon` | Alerts + Signals | **FIXED** — Signals → `Radio` |
| `TraceIcon` | Traces + Debug sessions | **FIXED** — Debug sessions → `Bug` |
| `PatchIcon` | Improve + Artifacts + Promotions | **FIXED** — Artifacts → `Package`; Promotions → `TrendingUp` |
| `FileText` | Ledger + Prompts + Quickstart | **FIXED** — Ledger → `BookOpen`; Prompts → `FileCode`; Quickstart alone keeps `FileText` |
| `Settings` | Settings + Webhook DLQ | **FIXED** — Webhook DLQ → `Inbox` |

### Nav cognitive load (elevated)

Despite unique icons and Core-12 compliance, **nav cognitive load ≈ 6.7 / 10 (elevated)** from the combination of:

1. **Improve cluster** — four core siblings (Improve, Artifacts, Ledger, Promotions) plus three Advanced (Cost, Guardrails, Prompts) under one group label  
2. **Settings density** — Settings page exposes **19** visible tabs (21 tab defs, 2 `hidden`) in the settings rail  
3. **Dual / orphan routes** — `/signals`, `/fleet`, `/incidents`, `/observability` (+ observability children) remain discoverable via redirects, embeds, or URL only (see §5)

Icons no longer collide; IA breadth and hub dual-entry still tax recognition.

---

## 4. Advanced toggle — behavior & persistence

| Aspect | Behavior | Refs |
|---|---|---|
| Default | **Collapsed** (`true` = hide advanced) | `use-sidebar-prefs.ts:48-55`; `portal-chrome.tsx:180` |
| Storage key | `eden:sidebar:advanced-collapsed` | `use-sidebar-prefs.ts:46` |
| Persist | **localStorage only** (`"1"`/`"0"`) — **not** backend prefs | `43-45`, `61-68` |
| Filter | `applySidebarPrefs(prefs, advancedCollapsed)` drops `category === "advanced"` | `286-305`, `572` |
| UI | “Show advanced” / “Hide advanced” toggle; `aria-pressed={!advancedCollapsed}` | `portal-chrome.tsx:771-790` |
| Tour override | Product tour forces `setAdvancedCollapsed(false)` | `272` |
| Sidebar search | Respects hidden advanced via `hiddenIds` | `sidebar-search.tsx:15-16, 26-27, 62` |
| **⌘K** | Indexes **core + Advanced always** (no collapse filter) | `nav-commands.ts:124-130`; `command-palette.tsx:34-41` — matches U12 rule 3 |

Pin/hide/reorder/density: API + `sessionStorage` (`eden:sidebar-prefs:{orgId}`) — separate from Advanced — `use-sidebar-prefs.ts:70-71, 159+`

---

## 5. Dual entry / orphan routes

### Hub consolidations (canonical entry = hub tab)

| Legacy path | Redirect / hub rule | Sidebar entry | Page still exists? | Dual pattern |
|---|---|---|---|---|
| `/signals` | → `/alerts?tab=signals` | Advanced “Signals” → same hub href | `signals/page.tsx` | **Dual:** redirect + embedded in Alerts | 
| `/fleet` | → `/agents?tab=fleet` | No dedicated item (Agents advanced) | `fleet/page.tsx` | **Dual:** redirect + `agents` dynamic import |
| `/incidents` | → `/issues?tab=incidents` | **No** sidebar item (U12 wants core Incidents) | `incidents/page.tsx` (+ `[cluster_id]`) | **Dual:** redirect + Issues embed |
| `/observability` | → `/traces` | **No** sidebar item | `observability/page.tsx` + children | **Orphan hub** + partial child soft-lands |

**Refs**
- Redirect rules: `portal-hub-redirect.ts:21-23, 32`; `next.config.ts:142, 156, 165, 170`
- Embeds: `alerts/page.tsx:39, 296-314`; `agents/page.tsx:38-39, 217`; `issues/page.tsx:49, 334`
- Registry still lists all four prefixes: `portal-routes.ts:45, 52, 57, 62`

### Observability children (not in sidebar)

Still live as pages (some redirected):
- Redirected: `/observability`, `/observability/apm`, `/observability/query` → traces; `/observability/eval` → evals — `next.config.ts:142-154`
- **Orphan / discoverable only by URL or in-page links:** `mcp`, `decisions`, `memory`, `retrieval`, `cohorts`, `time-travel` under `app/(portal)/observability/`

### U12 “unlisted allowlist”

**Missing.** Spec rule 5 (`u12-portal-ia.md:54`) requires sidebar OR explicit `unlisted` allowlist — **no `unlisted` symbol** in portal. Agreement is only `collectSidebarHrefs` ⊆ `KNOWN_PORTAL_PREFIXES` (`u18-portal.test.ts:31-36`).

---

## 6. U12 ≤12 core alignment

| Check | Status | Evidence |
|---|---|---|
| Numeric ≤12 core | **PASS** | `CORE_NAV_ITEM_COUNT ≤ 12` — `u18-portal.test.ts:13-15`; actual **12** |
| Locked U12 tree match | **FAIL / drift** | Spec `u12-portal-ia.md:17-34` vs shipped config |

**U12 locked core vs shipped**

| U12 item | Shipped? |
|---|---|
| Home `/dashboard` | Yes |
| Traces `/traces` | Yes |
| Issues `/issues` | Yes (label “Agent Issues”) |
| **Incidents `/incidents`** | **No** — folded into Issues tab; not core leaf |
| Alerts `/alerts` | Yes |
| Artifacts `/artifacts` | Yes |
| **Book** | **Absent** from sidebar |
| **Drift** | **Absent** from sidebar |
| Improve queue `/improve` | Yes |
| **Playgrounds / Experiments / Datasets** as core leaves | **No** — single **Evals** hub (`/evals`); list URLs redirect (`portal-hub-redirect.ts:15-19`) |
| Settings | Yes |
| Extra shipped core not in U12 lock | Audit trail, Ledger, Promotions, Quickstart |

Spec Advanced list (`u12:40-42`) largely matches: Signals, Analytics, Guardrails, Prompts, Cost, Debug sessions, Agents — behind toggle. Fleet not a sidebar Advanced leaf (hub tab only).

---

## 7. Breadcrumb vs sidebar label drift

Breadcrumbs: `breadcrumbs.ts`. Chrome prefixes last crumb with `GROUP_LABEL[category]` — `portal-chrome.tsx:938-941`.

### Leaf label drift (same route segment)

| Segment | Sidebar label | Breadcrumb label | Drift? | Refs |
|---|---|---|---|---|
| `docs` | Quickstart | Documentation | **YES** | sidebar `247`; crumbs `31` |
| `issues` | Agent Issues | Agent Issues | no | `93`; `52` |
| Mobile Issues | “Issues” | — | **YES** vs sidebar | `MobileBottomNav.tsx:40` |

Most other shared hubs match (Home, Traces, Alerts, Agents, Cost, Evals, Improve, Artifacts, Ledger, Promotions, Guardrails, Prompts, Audit trail, Debug sessions, Settings).

### Category / group-prefix drift (orphan & hub routes)

| Segment | Breadcrumb `category` → displayed group | Reality / sidebar | Drift |
|---|---|---|---|
| `datasets`, `labeling` | `build` → **Home** | Evaluate hub via `/evals` | **YES** — `breadcrumbs.ts:74-75` |
| `book`, `drift` | `automate` → **Evaluate** | U12: Improve; not in sidebar | **YES** — `86-87` |
| `studio` | `optimize` → **Improve** | Redirects to `/evals` (Evaluate) | **YES** — `53` |
| `observability`, `fleet`, `signals`, `incidents` | `observe` | No sidebar leaf (hub/orphan) | crumbs exist; nav absent — `34-35, 46, 72` |

### Mobile vs desktop IA

| Surface | Items |
|---|---|
| Mobile core (4) | Home, Traces, Issues, Improve — `MobileBottomNav.tsx:37-42` |
| More sheet | Artifacts, Alerts, Evals, Ledger, Promotions, Debug sessions, Settings — `45-53` |
| Gaps vs desktop core | No Audit trail / Quickstart / Promotions in core bar; Debug sessions in More but desktop Advanced |

---

## Cross-surface wiring (complete)

| Surface | Role | Key files |
|---|---|---|
| Sidebar | `DEFAULT_SIDEBAR` + prefs + Advanced | `sidebar-config.ts`, `use-sidebar-prefs.ts`, `portal-chrome.tsx:572+` |
| ⌘K / cmdk | Full sidebar + `PALETTE_ACTIONS` | `nav-commands.ts`, `command-palette.tsx` |
| Breadcrumbs | `BREADCRUMB_LABELS` + `GROUP_LABEL` | `breadcrumbs.ts`, `portal-chrome.tsx:571, 938-941` |
| Mobile | Fixed 4 + More (not Advanced-aware) | `MobileBottomNav.tsx` |
| Route registry | `KNOWN_PORTAL_PREFIXES` / removed prefixes | `portal-routes.ts` |
| Hub redirects | Query-preserving consolidations | `portal-hub-redirect.ts`, `next.config.ts:109-171` |

---

## Verdict (for parent)

1. **Core count = 12** (≤12 OK); **Advanced top-level = 7** (+1 nested).  
2. **build/automate/optimize** ids intentionally misaligned with Home/Evaluate/Improve labels.  
3. **Icon collisions = 0** (all 21 nav icons distinct); prior 5-set collision table **SUPERSEDED**. Nav cognitive load still **~6.7/10 elevated** (Improve cluster + Settings 19 tabs + dual/orphan routes).  
4. Advanced = **localStorage-only**; ⌘K always includes Advanced.  
5. `/signals`, `/fleet`, `/incidents`, `/observability` = **redirect dual-entry + lingering page.tsx**; observability children largely orphaned from nav.  
6. **Numeric U12 ≤12 pass; locked tree fail** (no Incidents/Book/Drift core; Evals hub vs three Evaluate leaves; extras Audit/Ledger/Promotions/Quickstart).  
7. Main label drifts: **Quickstart vs Documentation**; mobile **Issues vs Agent Issues**; several breadcrumb categories still on old Build/Evaluate/Improve assignments for redirected routes.