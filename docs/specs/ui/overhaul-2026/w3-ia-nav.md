# W3/W4 — U12-Compatible IA Nav Cleanup

**Agent:** `w4-ia-nav-redirect` (refresh of `w3-web-ia-nav`)  
**Date:** 2026-07-20  
**Scope:** Docs only — finalize IA contract for Wave 5+ implementers. No product code.  
**Status:** **LOCKED** — core ≤12 forever; leaf drift fixed via hubs / embeds / Advanced / redirects.  
**Anti-clutter:** Competing dual UIs = confusion ([`w4-anti-clutter-contract`](./w4-anti-clutter-contract.md) §8). Settings 19-tab rail → group/collapse Advanced (UX-CL-07).  
**Inputs:** [`w1-sidebar-ia.md`](./w1-sidebar-ia.md), [`w1-consolidated-inventory.md`](./w1-consolidated-inventory.md), [`w2-helicone-ia.md`](./w2-helicone-ia.md), [`w2-gap-matrix.md`](./w2-gap-matrix.md), [`../u12-portal-ia.md`](../u12-portal-ia.md)  
**Sibling:** [`w3-redirect-ia.md`](./w3-redirect-ia.md)

---

## 0. Verdict

| Check | Result |
|---|---|
| Live core count | **12** (`CORE_NAV_ITEM_COUNT`) — keep |
| U12 locked leaf set | **Drift** — do **not** restore Incidents/Book/Drift/Playgrounds/Experiments/Datasets as core leaves |
| Reconciliation | Adopt **live Eden core-12** as the U12-compatible lock; update U12 acceptance to hub/embed language |
| Core nav ceiling | **Hard ≤12** — never expand to “fix” leaf drift |

**Principle (Helicone H2 + gap matrix §1.3):** Named groups + short top-level. Fix orphans with redirects/embeds/`unlisted`, not more sidebar leaves.

---

## 1. Locked core-12 — live Eden vs U12 — reconciliation

### 1.1 Live Eden core-12 (CANONICAL — Wave 3 lock)

Source: `sidebar-config.ts` via [`w1-sidebar-ia.md`](./w1-sidebar-ia.md) §1.

| # | Label | href | Group (display) | Notes |
|--:|---|---|---|---|
| 1 | Home | `/dashboard` | Home | Top-level |
| 2 | Traces | `/traces` | Observe | Atomic observe log |
| 3 | Agent Issues | `/issues` | Observe | Hub; Incidents = tab |
| 4 | Alerts | `/alerts` | Observe | Hub; Signals = tab / Advanced |
| 5 | Evals | `/evals` | Evaluate | Mega-hub (Playgrounds/Experiments/Datasets tabs) |
| 6 | Improve | `/improve` | Improve | Queue |
| 7 | Artifacts | `/artifacts` | Improve | Moat spine |
| 8 | Ledger | `/ledger` | Improve | Governance moat |
| 9 | Promotions | `/promotions` | Improve | Closed-loop moat |
| 10 | Audit trail | `/audit-trail` | Workspace | Governance moat |
| 11 | Settings | `/settings` | Workspace | + API keys child (uncounted) |
| 12 | Quickstart | external docs | Workspace | Core leaf today; demote to footer is P2 only |

**Nested uncounted:** Settings → API keys (`/settings?tab=api-keys`) — core child, does not increment the 12.

### 1.2 U12 locked list (spec `u12-portal-ia.md` §1) — historical

| U12 item | href / target | Live status |
|---|---|---|
| Home | `/dashboard` | Core ✓ |
| Traces | `/traces` | Core ✓ |
| Issues | `/issues` | Core ✓ (label “Agent Issues”) |
| **Incidents** | `/incidents` | **Not core** — Issues hub tab + redirect |
| Alerts | `/alerts` | Core ✓ |
| Artifacts | `/artifacts` | Core ✓ |
| **Book** | agent picker → `/agents/[id]/book` | **Not core** — agent-scoped; Agents Advanced |
| **Drift** | agent picker → `/agents/[id]/drift` | **Not core** — agent-scoped; Agents Advanced |
| Improve queue | `/improve` | Core ✓ |
| **Playgrounds** | `/playgrounds` | **Not core** — Evals hub tab + redirect |
| **Experiments** | `/experiments` | **Not core** — Evals hub tab + redirect |
| **Datasets** | `/datasets` | **Not core** — Evals hub tab + redirect |
| Settings | `/settings` | Core ✓ |

U12 never listed Ledger / Promotions / Audit trail / Quickstart as core; live Eden does.

### 1.3 Reconciliation plan (do not explode sidebar)

| Drift item | Fix | Mechanism | Core count impact |
|---|---|---|---|
| Incidents | Stay under Issues | Keep redirect `/incidents` → `/issues?tab=incidents`; crumb/nav language “Agent Issues” | 0 |
| Playgrounds / Experiments / Datasets | Stay under Evals hub | Keep hub tabs + redirects; crumb category → Evaluate | 0 |
| Book / Drift | Discover via Agents Advanced + agent picker (U12 rule 1) | Agents in Advanced + mobile More; CrossLinkBar from Improve/Issues | 0 |
| Ledger / Promotions / Audit trail | Keep core (Eden moat) | Gap matrix §1.2 — do not delete for Helicone-thin nav | already in 12 |
| Quickstart | Keep core for Wave 3; optional P2 footer demote | If demoted later, free a slot — **do not** add a 13th first | 0 |
| Signals | Advanced only until F06 (U12 §4) | Drop duplicate Advanced leaf if Alerts tab covers it; redirect `/signals` | 0 |
| Cost `/optimization` | Demote as product leaf (Helicone H4) | Embed spend in Home/Observe KPIs + Settings Billing; children → hub `?tab=` or `unlisted` | Advanced only |
| Observability duals | Canonical `/traces` (+ facets) | Redirect live `/observability/{mcp,decisions,…}`; add `unlisted` allowlist (U12 rule 5) | 0 |
| Fleet | Agents hub tab | Redirect `/fleet` → `/agents?tab=fleet` | 0 |
| Webhook DLQ | Settings Developer tab only | Remove Advanced sidebar child | −1 Advanced nested |

**U12 doc update (Wave 3 owners):** Rewrite §1 locked tree to match §1.1 live core-12; rewrite §2 Advanced to named-group dump (see §3); keep rules 1–6; acceptance “Artifacts/Book/Drift discoverable” satisfied via Agents Advanced + picker, not new core leaves.

### 1.4 Advanced top-level (default hidden) — Wave 3 set

| Item | href | Disposition |
|---|---|---|
| Agents | `/agents` | Keep Advanced; **must** appear in mobile More (§3) |
| Analytics | `/analytics` | Keep Advanced |
| Signals | `/alerts?tab=signals` | Prefer Alerts-only; remove sidebar leaf when redirects solid |
| Debug sessions | `/debugger-sessions` | Keep Advanced |
| Cost | `/optimization` | Keep Advanced short-term; migrate per Helicone H4 |
| Guardrails | `/guardrails` | Keep Advanced (Improve cluster) |
| Prompts | `/prompts` | Keep Advanced (or fold into Evals later — P1) |

---

## 2. Group id vs label mismatch fix

### 2.1 Current mismatch (P0 code smell)

| Group `id` | Display `label` | Match? |
|---|---|---|
| `build` | Home | **NO** |
| `observe` | Observe | yes |
| `automate` | Evaluate | **NO** |
| `optimize` | Improve | **NO** |
| `workspace` | Workspace | yes |

Refs: `sidebar-config.ts`; `GROUP_LABEL` in `nav-commands.ts` / breadcrumbs; stale “Build / Observe / Optimize / Automate” comment in `sidebar-search.tsx`.

### 2.2 Locked rename (ids → labels)

Rename group ids to match display labels. Update all consumers in one pass.

| Old id | New id | Label (unchanged) | Default order |
|---|---|---|---|
| `build` | `home` | Home | 1 |
| `observe` | `observe` | Observe | 2 |
| `automate` | `evaluate` | Evaluate | 3 |
| `optimize` | `improve` | Improve | 4 |
| `workspace` | `workspace` | Workspace | 5 |

**Touch list:** `sidebar-config.ts`, `use-sidebar-prefs.ts` (`DEFAULT_GROUP_ORDER`), `nav-commands.ts` `GROUP_LABEL`, `breadcrumbs.ts` category fields, `portal-chrome.tsx` group prefix, prefs migration map `build→home`, `automate→evaluate`, `optimize→improve` (read old keys once, write new).

**Do not** relabel groups back to Build/Automate/Optimize — product language is Home / Observe / Evaluate / Improve / Workspace (Helicone H2 named groups).

---

## 3. Advanced toggle + mobile More sheet

### 3.1 Desktop Advanced toggle (keep shape; clarify job)

| Aspect | Contract |
|---|---|
| Default | Collapsed (`eden:sidebar:advanced-collapsed` = hide) |
| Persist | localStorage only (Wave 3); prefs API stays for pin/hide/reorder |
| UI copy | “Show advanced” / “Hide advanced” |
| Contents | §1.4 set — not a junk drawer for Settings tabs |
| Named groups | Advanced items still sit under Observe / Improve group chrome when expanded — do not invent a sixth group |
| Helicone H9 | Longer-term prefer group expand prefs over hide-product; Wave 3 keeps toggle but **must not** rely on it for Agents mobile discoverability |

### 3.2 Mobile More sheet — Agents P0

**Locked mobile core (4):** Home, Traces, Issues, Improve — unchanged (`u18-portal.test.ts`).

**More sheet — required Wave 3 delta:**

| Action | Item | Why |
|---|---|---|
| **ADD** | **Agents** → `/agents` | Gap matrix P0 #9; desktop Advanced-only; absent from More today |
| Keep | Artifacts, Alerts, Evals, Ledger, Promotions, Settings | Parity with desktop core / frequent |
| Keep | Debug sessions | Already in More; Advanced on desktop OK |
| Optional P1 | Analytics, Cost, Guardrails, Prompts, Audit trail | Via hamburger Advanced or later More sections — not blocking if Agents lands |

**Discoverability rule:** Any Advanced leaf that is a primary operator job (Agents) MUST appear in More **or** be promoted to core. Promotion to core is **forbidden** if it would make core >12 — therefore Agents stays Advanced + More.

### 3.3 Label parity mobile ↔ desktop

| Surface | Issues label | Contract |
|---|---|---|
| Desktop sidebar | Agent Issues | Keep |
| Mobile bottom | Issues (short) | OK for space; More/Agents use full “Agents” |
| Breadcrumb | Agent Issues | Match desktop |

---

## 4. Icon collision remediation priorities

Source: [`w1-sidebar-ia.md`](./w1-sidebar-ia.md) §3. Scanability — gap matrix P2; order by operator confusion risk.

| Pri | Icon | Collision | Remediation |
|--:|---|---|---|
| **P0** | `AlertNavIcon` | Alerts + Signals | Distinct icon for Signals **or** remove Signals sidebar leaf (prefer remove — Alerts tab) |
| **P0** | `Settings` | Settings + Webhook DLQ | Remove DLQ from sidebar (Settings rail only) — collision dissolves |
| **P1** | `TraceIcon` | Traces + Debug sessions | Unique debug/session icon for Debug sessions |
| **P1** | `PatchIcon` ×3 | Improve + Artifacts + Promotions | Unique icons per Improve-spine leaf (Artifacts ≠ queue ≠ promotions) |
| **P2** | `FileText` ×3 | Ledger + Prompts + Quickstart | Ledger book/ledger glyph; Prompts prompt glyph; Quickstart book-open / external |

Unique today (keep): `LayoutDashboard`, `ShieldAlert`, `AgentIcon`, `InsightsIcon`, `EvalIcon`, `CostIcon`, `GuardrailIcon`, `ShieldCheck`, `KeyRound`.

---

## 5. CmdK indexing rule

**U12 rule 3 — LOCKED:**

> ⌘K indexes **core + Advanced always**. Advanced collapse MUST NOT filter the command palette.

| Surface | Respects Advanced collapse? |
|---|---|
| Sidebar render | Yes — hide Advanced when collapsed |
| Sidebar search | Yes — respects `hiddenIds` |
| **⌘K / cmdk** | **No** — always include full `DEFAULT_SIDEBAR` advanced leaves + `PALETTE_ACTIONS` |
| Mobile More | Independent list — not Advanced-filtered; must include Agents |

Implementers: do not “fix” discoverability by filtering cmdk when Advanced is collapsed. That path already exists (`nav-commands.ts`); regression tests must assert Agents/Cost/Analytics appear in palette regardless of `eden:sidebar:advanced-collapsed`.

---

## 6. Breadcrumb language alignment

Chrome prefixes last crumb with `GROUP_LABEL[category]` (`portal-chrome.tsx`). Align category ids with §2 rename and hub reality.

### 6.1 Leaf label fixes

| Segment | Sidebar | Breadcrumb today | Fix |
|---|---|---|---|
| docs / Quickstart | Quickstart | Documentation | Pick one: **Quickstart** (match sidebar) or demote leaf and use Documentation in footer only |
| issues | Agent Issues | Agent Issues | Keep; mobile short “Issues” stays bottom-nav only |

### 6.2 Category / group-prefix fixes (after id rename)

| Segment(s) | Wrong category today | Locked category | Reason |
|---|---|---|---|
| `datasets`, `labeling`, `playgrounds`, `experiments`, `studio`, `synthetic` | `build` → Home (or misc) | `evaluate` | Evals hub cluster |
| `book`, `drift` | `automate` → Evaluate | `improve` **or** observe-via-Agents | Agent-scoped Improve moat; crumb “Agents › Book” preferred when under `/agents/[id]` |
| `observability`, `fleet`, `signals`, `incidents` | `observe` (OK) but no sidebar leaf | `observe` | Keep; pages redirect/unlisted — crumbs still Observe |
| Cost / optimization children | Improve (`optimize`) | Prefer Settings FinOps **or** keep Improve until Cost demotion ships | Align with Helicone H4 when leaf demoted |

### 6.3 Language glossary (single product voice)

| Say | Do not say |
|---|---|
| Home / Observe / Evaluate / Improve / Workspace | Build / Automate / Optimize (as user-visible group names) |
| Agent Issues | Issues (except mobile bottom short label) |
| Evals | Playgrounds/Experiments/Datasets as peer core leaves |
| Advanced | “Configure” for product Advanced (Configure = Settings entry if footer lands) |

---

## 7. Non-goals

| Non-goal | Rationale |
|---|---|
| **Core nav > 12** | Hard moat + U12 rule; gap matrix explicit non-goal |
| Restoring Incidents / Book / Drift / Playgrounds / Experiments / Datasets as core leaves | Leaf drift fixed by hubs/embeds/Advanced |
| Promoting Agents to core without dropping another core leaf | Would break ≤12; use More + Advanced + ⌘K |
| Cloning Helicone thin nav by deleting Ledger / Promotions / Audit trail | Eden governance moat |
| Replacing Advanced toggle with Helicone-only expand prefs in Wave 3 | H9 is P1; Agents-in-More unblocks discoverability first |
| Skinning Helicone/Laminar colors into sidebar | Patterns not skins |
| Raising Settings rail to a 13th product leaf | Settings already core #11 |

---

## 8. Implementer checklist (Wave 3 WP-G)

- [ ] Treat §1.1 as locked core-12; update `u12-portal-ia.md` §1 to match
- [ ] Rename group ids `build`/`automate`/`optimize` → `home`/`evaluate`/`improve` + prefs migration
- [ ] Add **Agents** to mobile More sheet; keep mobile core 4
- [ ] Remove Webhook DLQ from sidebar Advanced children
- [ ] Prefer drop Signals Advanced leaf once Alerts tab + redirect proven
- [ ] Assert ⌘K indexes Advanced when collapse = true (regression)
- [ ] Align breadcrumb categories per §6; fix Quickstart vs Documentation
- [ ] Icon P0 collisions (Alerts/Signals, Settings/DLQ)
- [ ] Redirect / `unlisted` allowlist for observability duals (U12 rule 5) — coordinate orphan-route agent
- [ ] **Never** ship a PR that sets `CORE_NAV_ITEM_COUNT` > 12

---

## 9. Evidence index

| Claim | Source |
|---|---|
| Core = 12; Advanced = 7+1 | [`w1-sidebar-ia.md`](./w1-sidebar-ia.md) §1 |
| Group id ≠ label | [`w1-sidebar-ia.md`](./w1-sidebar-ia.md) §2; inventory §3.1 |
| Icon collisions | [`w1-sidebar-ia.md`](./w1-sidebar-ia.md) §3 |
| ⌘K always Advanced | [`w1-sidebar-ia.md`](./w1-sidebar-ia.md) §4; U12 rule 3 |
| Breadcrumb drift | [`w1-sidebar-ia.md`](./w1-sidebar-ia.md) §7 |
| Agents missing from More | [`w1-mobile-shell.md`](./w1-mobile-shell.md) §1; gap matrix §2.11 |
| Helicone named groups / Cost dimension / Advanced dump | [`w2-helicone-ia.md`](./w2-helicone-ia.md) H2–H4, H9 |
| ≤12 moat; no expand to fix drift | [`w2-gap-matrix.md`](./w2-gap-matrix.md) §1.2–1.3, WP-G |
| U12 locked tree + rules | [`../u12-portal-ia.md`](../u12-portal-ia.md) |

---

*End of `w3-ia-nav`. Core-12 confirmation: Home, Traces, Agent Issues, Alerts, Evals, Improve, Artifacts, Ledger, Promotions, Audit trail, Settings, Quickstart.*
