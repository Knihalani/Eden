# W3/W4 — Orphan Route Redirects / Nests + Dual Org Switcher

| Field | Value |
|---|---|
| **Agent** | `w4-ia-nav-redirect` (refresh of `w3-redirect-ia-spec`) |
| **Wave** | 4 — contracts refresh; **implements in Wave 5** `w5-ia-redirects` |
| **Status** | **LOCKED** (docs only) |
| **Backlog** | [`w3-p0-p3-backlog.md`](./w3-p0-p3-backlog.md) **UX-P0-13** + Top-20 GAPs |
| **Anti-clutter** | Dual routes = confusion — [`w4-anti-clutter-contract.md`](./w4-anti-clutter-contract.md) §8 · AC-11 |
| **IA sibling** | [`w3-ia-nav.md`](./w3-ia-nav.md) — core ≤12 lock; this file owns the redirect/nest map |
| **Inputs** | [`w1-consolidated-inventory.md`](./w1-consolidated-inventory.md) §8; [`w1-redirect-audit.md`](./w1-redirect-audit.md); [`w2-gap-matrix.md`](./w2-gap-matrix.md) §2.2; [`w2-laminar-contracts.md`](./w2-laminar-contracts.md) §B.1 |
| **Code refs (today)** | `clients/portal/next.config.ts` `redirects()`; `clients/portal/src/lib/portal-hub-redirect.ts`; `portal-routes.ts`; `sidebar-config.ts`; `nav-commands.ts` |
| **Redirect / nest / keep rules in §1** | **33** |

**Goal:** One canonical URL per job. Legacy list paths 308 (or query-preserving soft redirect) into hubs. Dual facet/orphan pages end. Dual org switcher removed from chrome/settings identity. Sidebar · ⌘K · `portal-routes` stay in agreement for Wave 5 CI.

**Principle (from [`w3-ia-nav.md`](./w3-ia-nav.md)):** Fix orphans with redirects / embeds / `unlisted` — never expand core past 12.

---

## 0. Behavior vocabulary

| Behavior | Meaning | When |
|---|---|---|
| **308 redirect** | Next.js `permanent: true` (HTTP 308). Bookmark/canonical language. | List consolidations with stable hub target; no query remap required |
| **307 soft redirect** | `permanent: false`. Prefer when remapping query keys (`trace_id`→`traceId`) so caches/CDNs do not pin a wrong mapping forever | Deep-link shims that rewrite params |
| **Soft nest** | List URL redirects to hub `?tab=` / `?view=` / `?facet=`; **same module** stays mountable via hub `dynamic()` / embed | Dual entry: filesystem page exists only as embed source |
| **Keep leaf Advanced** | No list redirect; route remains a real page; must be sidebar Advanced **or** U12 `unlisted` allowlist with reason | True Advanced hubs (`/debugger-sessions`); detail orphans |
| **Hub-only (no sidebar leaf)** | Canonical is hub tab/query; do **not** add a second sidebar href to the legacy path | Fleet, Incidents, Signals after IA cleanup |

**Mechanism note:** Static `next.config` redirects that already include `?` on the destination **drop** source query. Query-preserving consolidations must go through `portal-hub-redirect.ts` (`buildHubRedirectUrl`) **or** dedicated `has: [{ type: "query", … }]` rules (see `/observability?trace_id=` today).

---

## 1. Redirect / nest map

Columns: **from** → **to** · **behavior** · **status** · **notes**.

Status: `SHIPPED` = present in `next.config` / hub-redirect today · `GAP` = W1 orphan still live dual · `KEEP` = intentional leaf.

### 1.1 Observability → Traces / Evals

Cover: `/observability` + all children ([w1 §1.4](./w1-consolidated-inventory.md)).

| # | From | To | Behavior | Status | Notes |
|---|---|---|---|---|---|
| 1 | `/observability` | `/traces` | 308 | SHIPPED | Kill orphan hub landing |
| 2 | `/observability?trace_id=` | `/traces?traceId=:trace_id&view=traces` | 307 soft | SHIPPED | U01 / U18 deep-link shim; remap snake→camel |
| 3 | `/observability?traceId=` | `/traces?traceId=:traceId&view=traces` | 307 soft | SHIPPED | Already-canonical key |
| 4 | `/observability/apm` | `/traces` | 308 | SHIPPED | |
| 5 | `/observability/apm/:path*` | `/traces` | 308 | SHIPPED | Drop nested path; no soft nest |
| 6 | `/observability/query` | `/traces?view=query` | 308 + soft nest | SHIPPED | Query leaf embeds under Traces |
| 7 | `/observability/eval` | `/evals?tab=eval` | 308 + soft nest | SHIPPED | Not a Traces facet |
| 8 | `/observability/mcp` | `/traces?facet=mcp` | 308 + soft nest | **GAP** | Dual with Traces facet chip; end dedicated URL as canonical |
| 9 | `/observability/decisions` | `/traces?facet=decisions` | 308 + soft nest | **GAP** | |
| 10 | `/observability/memory` | `/traces?facet=memory` | 308 + soft nest | **GAP** | |
| 11 | `/observability/retrieval` | `/traces?facet=retrieval` | 308 + soft nest | **GAP** | |
| 12 | `/observability/time-travel` | `/traces?view=time-travel` | 308 + soft nest | **GAP** | Do **not** soft-land on debugger/query. Embed under Traces overflow |
| 13 | `/observability/cohorts` | `/traces?view=cohorts` | 308 + soft nest | **GAP** | Columnar UI nests under Traces legacy/overflow |
| 14 | `/observability/traces/:traceId` | `/traces?traceId=:traceId&view=traces` | 308 | SHIPPED | Legacy path shape |

**Post-redirect:** `/observability/*` list pages are not sidebar entries. Facet modules stay importable from `/traces` only. Prefer redirect+embed over leaving filesystem pages reachable without redirect.

### 1.2 Fleet · Signals · Incidents

| # | From | To | Behavior | Status | Notes |
|---|---|---|---|---|---|
| 15 | `/fleet` | `/agents?tab=fleet` | 308 + soft nest | SHIPPED | Canonical = Agents hub tab. No sidebar “Fleet” leaf ([w3-ia-nav](./w3-ia-nav.md) §1.3) |
| 16 | `/signals` | `/alerts?tab=signals` | 308 + soft nest | SHIPPED | Canonical = Alerts hub. **Drop** Advanced sidebar “Signals” leaf once redirect proven ([w3-ia-nav](./w3-ia-nav.md) §1.4) |
| 17 | `/incidents` | `/issues?tab=incidents` | 308 + soft nest | SHIPPED | Canonical = Issues hub tab. No core Incidents leaf (≤12 lock) |
| 18 | `/incidents/[cluster_id]` | *(same path)* | Keep leaf / **unlisted** | KEEP | Detail deep-linkable; list redirects. `unlisted` reason: “incident cluster detail” |

### 1.3 Evals standalones → hub tabs

Cover: `/studio`, `/playgrounds`, `/datasets`, `/experiments`, `/labeling`, `/synthetic` ([w1 §1.4](./w1-consolidated-inventory.md)).

| # | From | To | Behavior | Status | Notes |
|---|---|---|---|---|---|
| 19 | `/studio` | `/evals?tab=studio` | 308 + soft nest | SHIPPED | Evaluate hub tab |
| 20 | `/playgrounds` | `/evals?tab=playgrounds` | 308 + soft nest | SHIPPED | Not a core leaf ([w3-ia-nav](./w3-ia-nav.md) §1.2) |
| 21 | `/datasets` | `/evals?tab=datasets` | 308 + soft nest | SHIPPED | |
| 22 | `/experiments` | `/evals?tab=experiments` | 308 + soft nest | SHIPPED | |
| 23 | `/labeling` | `/evals?tab=labeling` | 308 + soft nest | SHIPPED | |
| 24 | `/synthetic` | `/evals?tab=synthetic` | 308 + soft nest | SHIPPED | |
| 25 | `/labeling/queues/[id]` | *(same path)* | Keep leaf / **unlisted** | KEEP | Workstation detail; not a hub list |
| 26 | `/datasets/[id]` | *(same path)* | Keep leaf / **unlisted** | KEEP | Spreadsheet editor (U10); list redirects to Evals tab |

**Sidebar:** single core **Evals** `/evals` only. Do not re-add Playgrounds / Experiments / Datasets as core leaves.

**⌘K:** Index hub destinations (`/evals?tab=…`) and canonical labels — not dead standalone list paths as primary hits.

### 1.4 Legacy tools · query leaves

Cover: `/replay`, `/debugger`, `/inspector`, query leaves, adjacent observe renames.

| # | From | To | Behavior | Status | Notes |
|---|---|---|---|---|---|
| 27 | `/inspector` | `/traces?view=inspect` | 308 + soft nest | SHIPPED | Legacy tool → Traces overflow/view |
| 28 | `/replay` | `/traces?view=replay` | 308 + soft nest | SHIPPED | Also in `HUB_REDIRECT_RULES` for query merge |
| 29 | `/debugger` | `/traces?view=debug` | 308 + soft nest | SHIPPED | Distinct from Advanced `/debugger-sessions` |
| 30 | `/apm` | `/traces` | 308 | SHIPPED | Adjacent observe rename |
| 31 | `/apm/:path*` | `/traces` | 308 | SHIPPED | |
| 32 | `/traces/:traceId` | `/traces?traceId=:traceId&view=traces` | 307 soft | SHIPPED | Master–detail URL contract (U01) |
| 33 | `/debugger-sessions` (+ `/[id]`) | *(same)* | Keep leaf Advanced | KEEP | Real Advanced surface; **not** `/debugger` |

**Out of this map (owned elsewhere):** `/optimization/*` Cost IA (Helicone H4 / [`w3-ia-nav`](./w3-ia-nav.md)); Analytics consolidations already shipped; Improve list redirects; Settings `?tab=` — not Observe orphans.

### 1.5 Rule count

| Bucket | Count |
|---|---|
| Observability (§1.1) | 14 |
| Fleet / Signals / Incidents (§1.2) | 4 |
| Evals (§1.3) | 8 |
| Legacy tools / query (§1.4) | 7 |
| **Total redirect / nest / keep rules** | **33** |
| Of which **GAP** (must add in W4) | **6** (`mcp`, `decisions`, `memory`, `retrieval`, `time-travel`, `cohorts`) |
| Of which **KEEP leaf** | **4** (incident detail, labeling queue detail, dataset detail, debugger-sessions) |

---

## 2. Dual org-switcher removal (chrome only)

**Smell:** Clerk `OrganizationSwitcher` in sidebar **and** Settings page `<Select>` + `setCurrentOrg` / `setActive` ([w1-chrome-mapper](./w1-chrome-mapper.md) §5; [w2-gap-matrix](./w2-gap-matrix.md) P0; backlog **UX-P0-02** / **UX-P0-03**).

Cross-ref **Settings** (identity chrome — not a product leaf change):

| Action | Spec |
|---|---|
| **Keep** | Shell-owned org control: Clerk `OrganizationSwitcher` in sidebar (`portal-chrome`) |
| **Remove** | Settings page body org `<Select>` that switches active org (second global switcher) |
| **Keep on Settings → Org tab** | Org *settings* (rename, slug, create, members entry) — not a second global switcher |
| **Collapsed rail** | Org switch must remain reachable when sidebar collapsed (header overflow, icon-rail Clerk control, or user-menu “Switch organization”) — gap today ([w1-chrome-mapper](./w1-chrome-mapper.md) §8.3); backlog **UX-P0-03** |
| **Out of scope here** | Billing/plan chrome; density control; double “Settings” title (UX-P0-02 title half — separate polish) |

**Acceptance:** Exactly one global org-switch UI in the logged-in shell. Settings no longer presents a parallel tenant picker in the page header band.

---

## 3. Sidebar + ⌘K + route-registry agreement (Wave 4 `w4-ia-redirects`)

Owns UX-P0-13 exit for implementers. Aligns with U18 route agreement + U12 rule 5 (`unlisted`).

### 3.1 Sources of truth

| Surface | File | Role |
|---|---|---|
| Sidebar | `sidebar-config.ts` + prefs | Visible hrefs (core + Advanced) |
| ⌘K | `nav-commands.ts` → `collectSidebarHrefs` + actions | Always indexes Advanced (collapse does not hide — [`w3-ia-nav`](./w3-ia-nav.md) §5) |
| Registry | `portal-routes.ts` `KNOWN_PORTAL_PREFIXES` | Prefix allowlist for known/redirect survivors |
| Redirects | `next.config.ts` + `portal-hub-redirect.ts` | Canonicalization |
| Unlisted | **Missing today** — add `UNLISTED_PORTAL_ROUTES` (U12 rule 5) | Detail/keep leaves with reason |

### 3.2 Agreement tests (implement in W4)

| ID | Assert |
|---|---|
| **T1** | Every `sidebar-config` href (path only) ∈ `KNOWN_PORTAL_PREFIXES` **or** external docs URL |
| **T2** | Every `(portal)/**/page.tsx` path is **either** (a) sidebar/⌘K reachable, (b) listed in `HUB_REDIRECT_RULES` / `next.config` redirects, or (c) `UNLISTED_PORTAL_ROUTES` with reason |
| **T3** | No sidebar href points at a **from** path in §1 that 308s away (use hub destination). Signals Advanced leaf removed |
| **T4** | `collectSidebarHrefs()` ⊆ known prefixes; ⌘K primary nav entries match sidebar canonical destinations for Evaluate/Observe duals |
| **T5** | `REMOVED_PORTAL_PATH_PREFIXES` never appear in sidebar, ⌘K, mobile More, or cross-links |
| **T6** | GAP rules 8–13 present: `/observability/{mcp,decisions,memory,retrieval,time-travel,cohorts}` → Traces facet/view |
| **T7** | Deep-link cases §4: `/observability?trace_id=X` → location contains `traceId=X` (and not bare `/observability`) |
| **T8** | Org switcher: Settings page source has **no** global org `<Select>` switcher; chrome still mounts Clerk switcher; collapsed path has switch affordance |
| **T9** | `CORE_NAV_ITEM_COUNT` ≤ 12 after Signals leaf drop; Fleet / Incidents / Evals standalones never reappear as core leaves |

Prefer extending `clients/portal/src/lib/__tests__/u18-portal.test.ts` (existing “U18 route agreement”) rather than a one-off suite. Wave 4 agent id: **`w4-ia-redirects`**.

### 3.3 Nav product language after cleanup

| Job | Canonical href | Sidebar |
|---|---|---|
| Traces / facets / legacy tools | `/traces` (+ `?view=` / `?facet=` / `?traceId=`) | Core Traces |
| Fleet | `/agents?tab=fleet` | Advanced Agents only |
| Signals | `/alerts?tab=signals` | Via Alerts hub (not Advanced Signals leaf) |
| Incidents list | `/issues?tab=incidents` | Via Issues hub |
| Evals tabs | `/evals?tab=*` | Core Evals |
| Debug sessions | `/debugger-sessions` | Advanced (keep) |

---

## 4. Deep-link preservation rules

| Incoming | Outgoing | Rule |
|---|---|---|
| `trace_id` | `traceId` | Always remap on observe/traces redirects. Accept both on ingress; emit camelCase only |
| `traceId` | `traceId` | Pass through |
| `span_id` / `spanId` | `spanId` | Same remap policy when present |
| `view`, `facet`, `tab`, `filter`, `pastHours`, `chat` | unchanged | Merge via `URLSearchParams`; do not drop unknown keys on soft nest |
| Hub `tab` / `view` / `facet` from rule | set if absent | Do not overwrite explicit incoming `tab`/`view`/`facet` (`portal-hub-redirect` pattern) |
| `/traces/:traceId` path param | `?traceId=&view=traces` | Soft 307; list stays mountable |
| Hash `#…` | preserve when using client hub-redirect | `next.config` may drop hash — document; prefer client merge for in-app navigations |
| `/debugger?trace_id=` | `/traces?view=debug&traceId=` (after remap) | Legacy debugger leaf → view + id |
| Facet deep links | `/observability/{facet}` → `/traces?facet=` | Preserve any extra query (`filter`, `pastHours`, …) via hub-redirect merge |

**Forbidden:** Primary open navigation to `/observability?trace_id=` (U01 / Laminar contracts §B.4). Redirect shim only.

**Query leaf:** Prefer `/traces?view=query` with optional prefilled query param; do not require `/observability/query` in new links.

---

## 5. Non-breaking migration notes

1. **Ship GAP redirects before deleting page modules.** Soft nest: keep `dynamic()` embeds under hubs; 308 list URLs first.
2. **Permanent vs soft:** Use 308 for stable path renames; 307 for param remaps (`trace_id`→`traceId`) until analytics show negligible snake_case traffic, then optionally promote to 308.
3. **Static redirect + `?` destination:** Prefer `HUB_REDIRECT_RULES` + client/middleware merge for query-preserving consolidations; keep special-case `has: query` rules for observability deep links.
4. **Do not** redirect `/incidents/[cluster_id]`, `/labeling/queues/[id]`, or `/datasets/[id]` in the same wave as list consolidations — register `unlisted` first.
5. **Do not** conflate `/debugger` (→ traces view) with `/debugger-sessions` (Advanced keep).
6. **Signals:** Removing Advanced nav item is non-breaking if `/alerts?tab=signals` remains and `/signals` 308 stays; update hard-coded Advanced hrefs/tests ([w3-ia-nav](./w3-ia-nav.md) checklist).
7. **Fleet:** Agents Advanced remains the discoverability path; mobile More must expose Agents (**UX-P0-14**) — orthogonal to redirect.
8. **U12 locked tree vs redirects:** Keeping Incidents/Playgrounds/etc. as redirects into hubs satisfies bookmarks without inflating core >12. Intentional drift vs historical U12 locked list — live core-12 in [`w3-ia-nav`](./w3-ia-nav.md) §1.1 wins.
9. **Registry:** Keep legacy prefixes in `KNOWN_PORTAL_PREFIXES` while redirects exist (comment: “Deep-link / tab-source survivors”). Remove only after traffic + `unlisted` audit.
10. **Org switcher:** Remove Settings Select in the same Wave 4 PR as collapse-safe chrome switch path so users are never left without a switcher.
11. **E2E / golden:** Update fixtures still hitting `/observability/mcp` etc. as canonical URLs to `?facet=` forms; keep one redirect assertion suite.
12. **Rollback:** Feature-flag unnecessary for pure 308 adds; Settings org Select removal should be one PR with chrome collapse fix for safe rollback.
13. **Embed-only phase:** Until GAP 308s land, facet pages may remain URL-reachable — treat as temporary dual; do not add sidebar leaves.

---

## 6. Acceptance (spec exit → W4)

- [ ] All **33** rules in §1 documented in code (`next.config` / `HUB_REDIRECT_RULES` / `UNLISTED_*`)
- [ ] Six **GAP** observability children redirect to Traces `facet`/`view`
- [ ] Dual org switcher removed per §2 (Settings chrome only)
- [ ] Agreement tests T1–T9 green under `w4-ia-redirects`
- [ ] Deep links §4 verified (`trace_id` → `traceId`)
- [ ] No new sidebar leaves for Fleet / Signals / Incidents / Evals standalones / observability
- [ ] Core count still ≤12 after Signals Advanced leaf drop

**Feeds:** Wave 4 `w4-ia-redirects`; U18 WP7/WP9; U12 rule 5 unlisted allowlist; UX-P0-13.

**Deliverable path:** `docs/specs/ui/overhaul-2026/w3-redirect-ia.md`
