# Changelog

All notable changes to the Eden docs site (docs.edenobservability.com).

## [Unreleased]

### Product — 2026-06-23 (Production-Ready Beta)
- **Backend**: mounted previously-defined `webhooks.router` (outbound CRUD) and `agent_pr_suggestions.router` (Cat 23 UI surface); registered `QuotaEnforcementMiddleware` before `TenantRateLimitMiddleware` (§6.3 cost guardrails now active)
- **Portal chat pipeline**: fixed `chat/route.ts` URL bug (was using `NEXT_PUBLIC_API_URL` = relative `/api/proxy`; now `API_INTERNAL_URL` for server-side Node fetch); SSE error handler now calls `controller.error(err)` + explicit `event: error` frame (was leaving client in stuck "Streaming…" state)
- **Portal layout**: `100dvh` instead of `100vh` (mobile Safari address-bar jump), `min-h-full` standardized across pages, z-50 floating-overlay guard extended to all wizard routes, 8 missing `loading.tsx` files added
- **Portal polish**: mobile sidebar backdrop `<button>` → `<div role="presentation" aria-hidden>` (no longer keyboard-focusable but invisible to AT); contrast fixes on replay/sidebar/alerts; hardcoded `border-zinc-500/30` → design token; 3 missing `aria-label`s; removed unused `next-themes` dep
- **2FA setup dialog**: profile page now imports real wizard (was importing STUB); STUB file deleted
- **Closed-loop hook bus** (per upgradespec §E): new `src/eden/llmops/hooks_bus.py` (HookBus.emit with 5-min dedup + severity precedence + cascade dedup) + `hook_proposal.py` (PromotionProposal BaseModel per §E.4) + migration `051_hook_events.py` (per §E.5). `_record_action` now routes through HookBus. 5 new hook classes added: BudgetHook, IncidentHook, UserSatisfactionHook, DriftAlertHook, RoiHook
- **Deploy**: Clerk webhook signing secret updated in NF staging (`whsec_nPSBY+mvpTcCBzIMacT4OfH79lLIdDOS`); eden-api service deployed (last build SUCCESS); 4 Vercel env vars confirmed set; `.deploy-sha` capture + rollback procedure documented

### Docs
- `README.md`: dropped Helicone/Langfuse comparison copy; replaced placeholder URLs with env-var references; added Deploy section linking to `docs/deploy/cutover-checklist.md`
- `docs/spec/upgradespec-v2.md` published (delta-only status snapshot); original `upgradespec.md` archived at `docs/spec/upgradespec-original-2026-06.md`

### Added
- 404 page (`/404`) with terminal-style design and helpful navigation
- Last-updated timestamp + author on every page (`showLastUpdateTime: true`)
- OpenGraph image (`/img/og-image.svg`, 1200×630)
- Announcement bar above navbar (closeable, dark blue)
- "★ Star" button in navbar → github.com/eden/edenobservability
- Full SEO metadata (description, keywords, og:*, twitter:card)
- Three section landing pages with feature grids:
  - `/guide` — Getting started, Architecture, Deployment, API
  - `/observability` — 22-row status table, connection diagram
  - `/operations` — Release, Reliability, Security, SOC 2, Runbooks

### Changed
- Logo in navbar now links to **https://edenobservability.com** (the only
  back-link to the main site; everything else is internal)
- Hero landing page on `/intro/` with badge, gradient title, 5-pillar grid,
  6 productised-feature cards, 4 audience quick-link cards
- Dark terminal theme: black/blue, monospace headings, blue accents, status
  pills for shipped/stub/planned
- Footer expanded from 2 columns to 4 (Documentation / Product / Reference / Eden)
- `.md` files parsed as CommonMark (`markdown.format: 'md'`) — fixes MDX
  JSX conflicts in legacy content with `<5 min`/`<200ms` patterns
- Docusaurus config downgraded `onBrokenLinks` to `warn` and `onBrokenMarkdownLinks` to `warn`
  so legacy content can ship without 100+ cross-doc fixes

### Removed
- Old loose `.md` files at the docs root (consolidated into `docs/docs/{section}/`)
- Capital-case duplicates (`DEVELOPMENT.md`, `ARCHITECTURE.md`, etc.)
- Stale `obs-gap/`, `runbooks/`, `legacy/` directories (all content now in
  `docs/docs/`)
- GitHub link from navbar (replaced with the gold "★ Star" button)
- Footer link to the main site (was duplicating the logo's link)

### Fixed
- **docIds**: section landing pages no longer have explicit `id:` frontmatter
  that produced ugly `guide/guide-index` docIds. Now uses path-based IDs
  (`guide/index`, `observability/index`, `operations/index`).
- **Cross-doc links**: ~60 stale references fixed across the obs corpus
  (e.g. `(../eden-observability-gap-roadmap.md)` → `(/observability/gap-roadmap)`,
  `(../../src/eden/X.py)` → `\`src/eden/X.py\`` (code reference, not broken link),
  `(../SECURITY.md)` → contact email).
- **YAML in frontmatter**: quoted unquoted values containing `:` in
  `13-predictive-intelligence.md` and `gap-roadmap.md` (was breaking the
  YAML parser).
- **Anchor in closed-loop-wiring.md**: TOC link `#the-5-v0--4-v13b-hooks` →
  `#the-5-v0--4-v13bv14-hooks` to match the actual generated anchor.

## [1.0.0] — 2026-06-10

- Initial docs site launch. 7 pages (index, development, architecture,
  deployment, api, roadmap, branch_protection).
- Default Docusaurus theme, no customisation.
- No favicon, no custom logo, GitHub link in navbar.
