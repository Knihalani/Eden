---
title: What's new
sidebar_label: What's new
sidebar_position: 99
---

# What's new

Track the recent changes to the Eden docs site.

## 2026-06-16 — Hero redesign + full standalone Docusaurus

The docs site is now a fully standalone, properly-themed Docusaurus
site. Only the logo in the navbar links back to the main site; everything
else is internal.

**New**
- Hero landing page on `/` with badge, gradient title, 5-pillar grid,
  6 productised-feature cards, 4 audience quick-link cards
- 3 section landing pages with feature grids:
  - [/guide](/guide) — Getting started, Architecture, Deployment, API
  - [/observability](/observability) — 22-row status table
  - [/operations](/operations) — Release, Reliability, Security, SOC 2, Runbooks
- 404 page with terminal-style design
- OpenGraph image for social previews
- Announcement bar above the navbar (closeable)
- "★ Star" GitHub button in the navbar
- Last-updated timestamp + author on every page
- Full SEO metadata (description, keywords, og:*, twitter:card)

**Changed**
- Logo in navbar now links to **https://edenobservability.com** (the only
  back-link to the main site; everything else is internal)
- Dark terminal theme matching the Eden portal (black/blue, monospace
  headings, blue accents)
- Footer expanded from 2 columns to 4 (Documentation / Product / Reference / Eden)

**Fixed**
- ~60 stale cross-doc links across the observability corpus
- docIds for section landing pages (no more `guide/guide-index` weirdness)
- YAML frontmatter in `13-predictive-intelligence.md` and `gap-roadmap.md`
- Broken TOC anchor in `17-closed-loop-wiring.md`

**Removed**
- 7 capital-case duplicate docs files
- Stale `obs-gap/`, `runbooks/`, `legacy/` directories (all content now
  under `docs/docs/{section}/`)
- Footer link to the main site

See `docs/CHANGELOG.md` in the source repo for the full
machine-readable changelog (this page is the human-friendly
version).
