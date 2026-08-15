# Wave 2/4 — Linear + Stripe Dashboard Chrome Quality Bar

**Agent:** `w4-linear-stripe` (refresh of `w2-linear-stripe-chrome`)  
**Date:** 2026-07-20  
**Status:** Wave 4 refresh — calm craft feeds hierarchy + anti-clutter  
**Scope:** Patterns / layout / IA only — **not** Linear purple, Stripe blurple, brand fonts, or marketing look.  
**Mode:** Research + docs. No product UI changes.  
**Eden baseline:** [`w1-chrome-mapper.md`](./w1-chrome-mapper.md) · [`w1-token-audit.md`](./w1-token-audit.md) · [`w1-consolidated-inventory.md`](./w1-consolidated-inventory.md) · [`w1-hub-surfaces.md`](./w1-hub-surfaces.md)  
**Binding peers:** [`w3-hierarchy-spec.md`](./w3-hierarchy-spec.md) · [`w4-anti-clutter-contract.md`](./w4-anti-clutter-contract.md)

**Focus:** Spacing rhythm · header hierarchy · **single identity** · quiet chrome · settings search · command palette.

---

## 1. Sources

### Linear (product craft / interaction)

| Source | Why |
|---|---|
| [Linear engineering blog — Invisible details (contextual menus)](https://linear.app/blog/invisible-details) | Keyboard-first teaching: shortcuts surface next to actions; menus teach ⌘K / chord habits |
| [designsystems.one — Linear breakdown](https://www.designsystems.one/design-systems/linear) | 4px spacing ladder; command menu as reference; density rhythm (32/40px rows); warn against cloning look |
| [DesignMD — Linear tokens](https://designmd.cc/benchmarks/linear) | Spacing scale `4 · 8 · 12 · 16 · 24 · 32`; whitespace as functional separators in dense UI |
| [Gunpowder Labs — Linear patterns to copy](https://gunpowderlabs.com/2024/12/22/linear-delightful-patterns) | ⌘K as universal “do anything”; shortcut glyphs as training; progressive customization |
| [marcus-skills Linear design patterns](https://github.com/marcus/marcus-skills/blob/main/skills/linear-design-patterns/references/linear-design-system.md) | Inverted-L chrome (sidebar + header); flat data surface vs elevated overlays; cmdk grouped + recent |

### Stripe Dashboard (IA / search / settings chrome)

| Source | Why |
|---|---|
| [Stripe Docs — Web Dashboard basics](https://docs.stripe.com/dashboard/basics) | Primary nav IA; **settings = Personal / Account / Product**; `?` shortcuts sheet |
| [Stripe Docs — Dashboard search](https://docs.stripe.com/dashboard/search) | Global search across object types; filters/operators; org-scoped search; bookmarkable URLs |
| [Stripe Apps — Style / spacing tokens](https://docs.stripe.com/stripe-apps/style) | Named spacing ladder (`xsmall`…`xxlarge` → 4–48px); stack/gap layout model |
| [designsystems.one — Stripe Design](https://www.designsystems.one/design-systems/stripe-design) | 4px base; extended scale through 48/64 for section rhythm |
| Industry writeups (Instagram/carousel summaries of Dashboard chrome) | Always-visible global search + ⌘K; workspace badge; utility cluster top-right; job-labeled nav |

### Eden Wave 1 (gaps cited below)

- Chrome tree, sticky header, cmdk mount, dual org — `w1-chrome-mapper.md`
- Spacing hole `--space-2/3/4` only — `w1-token-audit.md` §2
- Settings double title + dual org + SettingsSearch — `w1-consolidated-inventory.md` §7.2, `w1-hub-surfaces.md` Settings

---

## 2. Pattern library

Each entry: **Name** · **Peer** · **Eden gap (Wave 1)** · **Priority**.

---

### P-01 — Complete 4px spacing ladder (tokenized)

| | |
|---|---|
| **Name** | Complete spacing rhythm (4px base → full ladder) |
| **Peer** | **Linear:** `4 · 8 · 12 · 16 · 24 · 32`. **Stripe Apps:** `xsmall(4) → small(8) → medium(16) → large(24) → xlarge(32) → xxlarge(48)`. Both treat rhythm as *tokens*, not ad-hoc rem. |
| **Eden gap** | Wave 1 token audit: only `--space-2` (8) / `--space-3` (12) / `--space-4` (16). Missing `--space-1` (4) and `--space-5`… (24/32/48). **Not in `@theme`** → no `p-space-*` utilities; all 5 `var(--space-*)` call sites live in `globals.css` only. Components use Tailwind `p-*` / `gap-*` arbitrarily (`w1-token-audit.md`, `w1-consolidated-inventory.md`). |
| **Priority** | **P0** |

**Layout note (no brand):** Peers use the ladder for *chrome bands* (header pad, rail pad, section gap, stack gap) so list/toolbar/form rows share one vertical beat. Eden’s `ResourcePageShell` already owns `gap-4` between header/toolbar/table — good seed; scale must back it.

---

### P-02 — Single page-identity title (no double header)

| | |
|---|---|
| **Name** | One H1 / identity title per view |
| **Peer** | **Linear:** inverted-L chrome; view title lives once (sidebar selection + content header, not duplicated labels). **Stripe:** section title appears in content; settings categories don’t re-echo “Settings” as a second page H1. |
| **Eden gap** | Settings: rail `<h2>Settings</h2>` **and** `<PageHeader title="Settings">` → double title (`settings/page.tsx:406` + `:422–425`; `w1-hub-surfaces.md`, inventory §7.2). Elsewhere hubs are mostly clean via `EmbeddedSurface` suppressing nested PageHeaders. |
| **Priority** | **P0** |

**Mapping:** Keep `PageHeader` as the sole page identity on Settings; rail should be category chrome only (search + tabs), or demote rail label to non-heading text.

---

### P-03 — Header hierarchy: shell breadcrumb ≠ page H1 overload

| | |
|---|---|
| **Name** | Two-tier chrome: location (shell) vs identity (page) |
| **Peer** | **Linear:** sticky thin top bar for context/actions; dense content header for filters — not three competing titles. **Stripe:** workspace badge + global search in shell; page H1 is the job (“Customers”, “Payments”), not a restatement of the product. |
| **Eden gap** | Sticky header already does location well: breadcrumbs + ⌘K + notifications (`w1-chrome-mapper.md` §2, `h-11`). `PageHeader` comments say “location lives in AppShell breadcrumbs; this is page identity + actions.” Gap is **overload**: Traces ≈ 3 bands (PageHeader + tabs/legacy + facets); Settings doubles identity. Shell is fine; page stack piles on. |
| **Priority** | **P0** (Settings double title); **P1** (Traces triple band — observe chrome, adjacent to this agent’s bar) |

---

### P-04 — Settings IA: categorized rail + in-rail search

| | |
|---|---|
| **Name** | Settings search + category groups |
| **Peer** | **Stripe:** Settings broken into **Personal / Account / Product** — job buckets, not a flat dump (`docs.stripe.com/dashboard/basics`). Large settings surfaces pair category IA with findability (search-or-filter within settings when count grows). Global Dashboard search is for *objects*; settings are navigated by category. |
| **Eden gap** | Eden already has `SettingsSearch` + `SettingsCategoryGroup` (Org / Members / Security / Compliance / Billing / Advanced) — strong peer alignment. Remaining gaps: double title (P-02), **~21 tabs** density, dual org switcher on same page (P-05), `Suspense fallback={null}` flash. Search filters tab labels only (no synonym / description index). |
| **Priority** | **P1** (search depth / synonyms); **P0** for chrome smells on same surface (title + org) |

---

### P-05 — Single org / workspace switcher in chrome

| | |
|---|---|
| **Name** | One workspace control — shell-owned |
| **Peer** | **Stripe:** workspace / account badge is a first-class shell control; org-scoped search respects active account. **Linear:** workspace/team switch lives in chrome, not duplicated inside every settings form. |
| **Eden gap** | Dual org: Clerk `OrganizationSwitcher` in sidebar **and** Settings `<Select>` + `setCurrentOrg` (`w1-chrome-mapper.md` §5, inventory §7.2). Collapsed sidebar **loses** org switcher with no header replacement. |
| **Priority** | **P0** |

---

### P-06 — Command palette as universal dispatcher (nav + actions + teach shortcuts)

| | |
|---|---|
| **Name** | ⌘K command menu quality bar |
| **Peer** | **Linear:** ⌘K = navigation + actions + entity search; **recent** first; **shortcuts printed** beside rows so palette trains muscle memory; context-scoped commands; fuzzy + grouped. **Stripe:** always-visible search + ⌘/Ctrl+K; `?` opens shortcut sheet; search spans object types without knowing the section. |
| **Eden gap** | Eden has cmdk (`command-palette.tsx`): Recent group, sidebar-derived groups, `PALETTE_ACTIONS`, focus trap, null-when-closed. Gaps vs peers: (1) **no shortcut glyphs** on rows (ChevronRight only); (2) mostly **route nav**, weak “do the thing” coverage vs Linear; (3) **no entity/async search** (traces, agents, issues) vs Stripe global search; (4) Settings tabs not first-class palette targets beyond `/settings`; (5) mount inside `main` at `z-50` competes with sidebar/FAB (`w1-chrome-mapper.md` overload #7). |
| **Priority** | **P0** (shortcut teaching + settings deep-links); **P1** (entity search); **P2** (context-scoped page actions) |

---

### P-07 — Density rhythm shared across chrome rows

| | |
|---|---|
| **Name** | Consistent row height / density beat |
| **Peer** | **Linear:** list/table/form rows share ~32 or ~40px rhythm; few densities, applied deliberately. **Stripe Apps:** named spacing tokens for stack gaps so density doesn’t drift per page. |
| **Eden gap** | Comfortable/Compact density exists (`DensityProvider`) but **control buried** in Settings → Sidebar only; affects nav/tables unevenly. Sticky header fixed `h-11` (44px) vs OnboardingBanner `top-14` (56px) mismatch (`w1-chrome-mapper.md`). Micro-density hotspots elsewhere (TranscriptView etc.) out of this chrome scope but same rhythm debt. |
| **Priority** | **P1** |

---

### P-08 — Global findability vs settings-local findability

| | |
|---|---|
| **Name** | Split search jobs: global objects vs settings tabs |
| **Peer** | **Stripe:** Dashboard search = customers/payments/invoices/… with filters (`amount:`, `is:customer`, …). Settings stay in categorized settings area. **Linear:** ⌘K unifies nav+actions; issue search is first-class in the same surface. |
| **Eden gap** | Header ⌘K and SettingsSearch are correctly **separate** — good. Gap: ⌘K copy says “Search pages, observability, settings…” but cannot jump to a settings *tab* (e.g. “SCIM”) or an entity ID. Users must open Settings then use rail search. |
| **Priority** | **P1** |

---

### P-09 — Shell utility cluster (search always reachable)

| | |
|---|---|
| **Name** | Always-visible search affordance in header |
| **Peer** | **Stripe:** global search visible in top chrome + ⌘K. **Linear:** ⌘K primary; keyboard-first users don’t need a large search field, but the hotkey is universal. |
| **Eden gap** | Desktop header already labels ⌘K; mobile uses icon (`w1-chrome-mapper.md` §2). Aligned. Residual: no `?` shortcuts sheet like Stripe. |
| **Priority** | **P2** |

---

### P-10 — Elevated overlays only for floating chrome

| | |
|---|---|
| **Name** | Flat chrome / elevated palette |
| **Peer** | **Linear:** data surfaces flat (borders/bg steps); shadows + radius reserved for modals, popovers, **command palette**. |
| **Eden gap** | Palette already elevated (`rounded-2xl shadow-2xl`). Shell uses border + blur header — fine. Anti-pattern risk is applying card/shadow stacks to Settings panels and hub toolbars (not peer chrome). |
| **Priority** | **P2** (guardrail) |

---

## 3. Eden mappings (implementation anchors)

| Peer pattern | Eden surface | Notes |
|---|---|---|
| Page identity H1 | `components/layout/page-header.tsx` | `title` / `eyebrow` / `actions`; `embedded` hides chrome. **Fix Settings** so only this (or only rail) owns “Settings”. |
| Shell location | `portal-chrome.tsx` sticky header | Breadcrumbs + ⌘K + notifications; keep as location tier. |
| Settings findability | `components/settings/settings-search.tsx` | Label substring filter; hide empty categories. Extend with aliases (e.g. “SSO” → Security tabs). |
| Settings categories | `SettingsCategoryGroup` + `CATEGORY_ORDER` | Peer: Stripe Personal/Account/Product — Eden’s 6 categories are product-appropriate; don’t flatten. |
| Org / workspace | Sidebar Clerk switcher vs Settings Select | Collapse to **one** shell-owned control; keep Settings Org *tab* for org *settings*, not switcher. |
| Command palette | `components/ui/command-palette.tsx` + `lib/nav-commands.ts` | Add shortcut column; index settings tabs; optional entity providers later. |
| Spacing tokens | `globals.css` `--space-*` + `@theme` | Expand beyond `--space-2/3/4`; wire ResourcePageShell / PageHeader / settings rail to tokens. |
| Vertical rhythm owner | `ResourcePageShell` `gap-4` + PageHeader `mb-4` collapse | Already avoids double-stack; extend to Settings custom split. |

---

## 4. Anti-patterns (do not copy)

| Anti-pattern | Why |
|---|---|
| **Clone Linear purple / indigo glow / Inter-as-brand** | Peers warn: visual clone reads as “Linear of X.” Eden already has Geist + own tokens — keep. |
| **Clone Stripe blurple / Sohne / marketing gradients** | Dashboard quality bar ≠ Stripe brand. |
| **Double titles** (rail H2 + PageHeader same string) | Explicit Eden P0 smell; peers avoid. |
| **Dual org switchers** (chrome + settings body) | Cognitive split + sync bugs; peers use one workspace control. |
| **Triple chrome bands** on hubs (identity + legacy links + facets as peers) | Traces Wave 1 finding; Linear/Stripe keep one filter band under one title. |
| **⌘K as nav-only dump** without shortcut teaching | Linear’s bar is the *training* surface; Eden shows chevrons only. |
| **One mega-search that mixes settings labels with payment-like operators** | Stripe separates object search language from settings IA; don’t force Stripe filter DSL into SettingsSearch. |
| **Card/shadow chrome for every settings panel** | Linear: flat structure; elevate only floating UI. |
| **Incomplete spacing scale used as “done”** | Having `--space-2/3/4` without 4/24/32 leaves rhythm to Tailwind noise. |
| **Density control only in buried settings** | Peers expose density or keep a single deliberate density; burying Compact under Sidebar settings fights consistency. |

---

## 5. P0 summary

| # | Pattern | Eden ask (layout only) |
|---|---|---|
| **P0-1** | Complete spacing ladder | Add `--space-1` + `--space-5+` (at least 24/32); register in `@theme`; stop relying on orphan 8/12/16-only tokens. |
| **P0-2** | Single Settings title | Remove rail `<h2>Settings</h2>` **or** drop PageHeader `title="Settings"` — one identity. |
| **P0-3** | Single org switcher | Shell-owned only; remove Settings duplicate Select (org *settings* stay on Org tab). Ensure collapsed rail still has a switch path. |
| **P0-4** | ⌘K quality bar | Show keyboard shortcuts on palette rows; deep-link Settings tabs from palette (parity with SettingsSearch). |

**P1 (next):** SettingsSearch synonyms; entity/async search in ⌘K; density beat + banner/header sticky offset; Traces band collapse (shared with observe chrome work).  
**P2:** `?` shortcuts sheet; overlay elevation guardrails.

---

## 6. Deliverable path

**Written:** [`docs/specs/ui/overhaul-2026/w2-linear-stripe-chrome.md`](./w2-linear-stripe-chrome.md)

---

### Evidence checklist

- [x] Wave 1 chrome / tokens / Settings double title / dual org cited
- [x] Linear + Stripe primary sources listed (docs + design breakdowns + eng blog)
- [x] Patterns named with peer · Eden gap · P0–P2
- [x] Eden mappings: PageHeader, SettingsSearch, cmdk, spacing tokens
- [x] Anti-patterns exclude brand cloning
- [x] Research/docs only — no product UI edits
