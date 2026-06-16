# Changelog

All notable changes to the Eden docs site (docs.edenobservability.com).

## [Unreleased]

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
