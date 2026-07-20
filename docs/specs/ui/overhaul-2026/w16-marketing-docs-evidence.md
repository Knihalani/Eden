# Wave 16 — Marketing + Docs polish evidence

**Date:** 2026-07-20  
**Brand SoT:** `.impeccable.md` (dark-terminal / Linear-adjacent)  
**Scope:** Marketing (`clients/portal/src/app/(marketing)`) + Docs (`docs/` Docusaurus). Portal core nav untouched.

---

## w16-inventory — Surface map

| Surface | Location | Stack | Entry routes |
|---|---|---|---|
| **Marketing** | `clients/portal/src/app/(marketing)/` | Next.js App Router, shared portal tokens (`globals.css`) | `/` landing; `/pricing`, `/about`, `/contact`, `/security`, `/changelog`, `/status`, `/health`, legal (`/privacy`, `/terms`, `/dpa`, `/subprocessors`, `/do-not-sell`) |
| **Marketing chrome** | `_components/` | RSC + client islands | Nav, Hero, TrustStrip, Install, Pillars, Improve, Assistant, FAQ, BottomCta, Footer, Backdrop |
| **Docs site** | `docs/` | Docusaurus 3.10 classic + Mermaid | `https://docs.edenobservability.com` — Diátaxis: Tutorials / How-to / Reference (+ Explanation under Reference sidebar) |
| **Docs theme** | `docs/src/css/custom.css`, `docusaurus.config.js`, `sidebars.js` | Infima tokens mirrored to Eden primitives | Home = `docs/docs/intro/index.md` (`slug: /`) |
| **Shared constants** | `clients/portal/src/lib/constants.ts` | `DOCS_URL`, `DOCS_QUICKSTART_URL` | Cross-links marketing ↔ docs |

**Not in scope / gaps:** No separate Mintlify/Nextra app. Internal runbooks under `docs/runbooks`, `docs/ops`, `docs/specs` are **not** public site content (excluded from Docusaurus build).

---

## Jobs completed

| # | Job | Verdict | What changed |
|---|---|---|---|
| 1 | `w16-inventory` | **PASS** | This map |
| 2 | `w16-brand-align` | **PASS** | Docs: killed purple/green hero gradients, amber GitHub pill, decorative phosphor `$` prompt; marketing backdrop no longer uses terminal green decoratively |
| 3 | `w16-marketing-hero` | **PASS** (prior + hold) | Hero already brand-first (`marketing-brand` + one lede + one CTA group + full-bleed Traces plane). No KPI theatre / card soup in first viewport |
| 4 | `w16-marketing-sections` | **PASS** | Pillars de-carded (border-t sections); TrustStrip / Improve / Assistant spacing tokens; BottomCta meta collapsed to one line; nav label **Docs** (was Quickstart) |
| 5 | `w16-docs-nav` | **PASS** | Navbar densified: Quickstart + 3 Diátaxis sidebars; **Start free** + **Portal** CTAs; hideable sidebar + auto-collapse; Find: ⌘/Ctrl+F affordance (no Algolia keys) |
| 6 | `w16-docs-content-chrome` | **PASS** | Prose measure, calm code blocks (no shadow), quieter admonitions, vsDark Prism, home cards without emoji / hover lift |
| 7 | `w16-a11y-motion` | **PASS** | Docs `prefers-reduced-motion` + focus rings; marketing backdrop / FAQ already motion-safe; green reserved for copy-success / live only |
| 8 | `w16-perf` | **PASS** | Portal Geist already `display: "swap"`; docs `@font-face` + `font-display: swap` + jsDelivr preconnect; logo height pinned |
| 9 | `w16-cross-links` | **PASS** | Docs footer Product column (Portal / Pricing / Security / Contact); home + 404 → Portal / Sign-up; marketing footer already linked Docs + Quickstart |
| 10 | `w16-evidence` | **PASS** | This file + checks below |

---

## Paths polished

### Marketing
- `clients/portal/src/app/(marketing)/_components/MarketingBackdrop.tsx`
- `clients/portal/src/app/(marketing)/_components/Pillars.tsx`
- `clients/portal/src/app/(marketing)/_components/TrustStrip.tsx`
- `clients/portal/src/app/(marketing)/_components/ImproveSpotlight.tsx`
- `clients/portal/src/app/(marketing)/_components/AssistantPreview.tsx`
- `clients/portal/src/app/(marketing)/_components/BottomCta.tsx`
- `clients/portal/src/app/(marketing)/_components/marketing-data.ts` (NAV_LINKS)

### Docs
- `docs/src/css/custom.css` (full theme calm rewrite)
- `docs/docusaurus.config.js` (nav / footer / sidebar / prism / preconnect)
- `docs/docs/intro/index.md` (brand-first hero, fewer cards, no emoji)
- `docs/src/pages/404.js` (calmer chrome + Portal / Pricing links)

### Evidence / tracker
- `docs/specs/ui/overhaul-2026/w16-marketing-docs-evidence.md` (this file)
- `docs/specs/ui/overhaul-2026/README.md` (Wave 16 status)

---

## Checks run

| Check | Result |
|---|---|
| `cd docs && npm run build` | **PASS** — static files in `docs/build` (exit 0, ~61s) |
| `cd clients/portal && bun run test -- src/app/(marketing)/__tests__/w6-5-marketing-legal-nav.test.tsx` | **PASS** — 13/13 |
| Geist CDN woff2 (`jsdelivr` geist@1.3.1) | **HTTP 200** (sans + mono) |

Portal full `next build` / `polish:check` **not** re-run (Waves 11–15 already green; marketing-only deltas + shared tokens untouched beyond consumption).

---

## Remaining gaps (honest)

1. **Docs search** — No Algolia / `@easyops-cn/docusaurus-search-local` wired (no API keys in-repo). Navbar shows browser Find hint only. Wire local search plugin when ready.
2. **Docs home still has link tiles** — Interactive destinations (starting points) keep bordered panels by design; not decorative card soup, but denser than a pure prose landing.
3. **Improve section overlap** — Landing still has Pillars Improve + ImproveSpotlight (intentional depth vs overview). Could merge in a later pass if scroll feels long.
4. **Docusaurus 3.10.1 → 3.10.2** available (build warned); out of polish scope.
5. **Live axe / visual smoke** — Not re-shot for marketing/docs this wave (no local `:3000` / docs serve in CI evidence).

---

## Exit

**Wave 16 — Complete (2026-07-20).** Marketing + docs aligned to Eden dark-terminal brand with clearer hierarchy, calmer chrome, and consistent cross-links. Portal product surface not reworked.
