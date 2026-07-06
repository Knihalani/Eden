# Eden Portal — Frontend Interface Quality Audit (2026-07-06)

**Repo:** `/Users/kaiavnihalani/Downloads/Eden`
**Scope:** `clients/portal/src/**` (Next.js 16 / React 19 / Tailwind v4 / Radix)
**Method:** Static analysis of design tokens, primitives, key pages, and antipattern survey. No runtime audit (no Axe scan results in this pass — see *Verification gaps*).
**Codebase size:** 301 `.tsx` files, 1398-line `globals.css`, 35 primitives in `components/ui/`, 30+ route segments.
**Audit framing:** *Not* the same as the previous Cat 23 / backend audit reports (`AUDIT-2026-07-06*.md`). Those cover backend discipline; this one audits the **frontend interface surface** against the `audit` skill's a11y / performance / theming / responsive / antipattern checklist.

---

## Anti-Patterns Verdict

**Pass — with reservations.** This portal does not look AI-generated. It has a clear, opinionated design language (terminal / phosphor-green / blue-tinted dark surfaces), a typed three-tier design-token system (primitive → semantic → component), explicit a11y commitments in code (touch-target bump on mobile, focus ring with offset, reduced-motion handling at both CSS and Framer-Motion layers), and extensive contextual `ponytail:` comments explaining *why* a CSS rule exists. The token ladder (112+ tokens) and dark-mode-only commitment are deliberate; nothing about it reads as default-LLM-output.

**Specific tells I checked and *did not* find:**

- ❌ No `bg-clip-text` / gradient text on metrics
- ❌ No spring / bounce / elastic easing (zero matches for `bounce|spring|elastic` in component files)
- ❌ No "pure black" `#000` or "pure white" `#fff` (terminal-tinged darks only)
- ❌ No layout-affecting transitions (`transition-(width|height|padding|margin)` = 0 matches)
- ❌ No glassmorphism sprawl (`backdrop-blur` used in 11 files, all contextual: dialog, command palette, modals, wizard, auth card, cookie consent — *purposeful*, not decorative)
- ❌ No "AI color palette" tells (cyan-on-dark with neon glow). The accent is a desaturated `#5B9EFF` terminal-blue paired with a phosphor-green `#5FE5A8` reserved for live/active states.
- ❌ No monospace-as-tech-shorthand abuse. `font-mono` appears 111 times but is consistently used for *real* code/data surfaces (trace IDs, durations, sparkline labels, command palette icons), not as cheap "developer aesthetic" filler.
- ❌ No nested Card-in-Card anti-pattern at scale (only 4 files flagged, all justifiable tool-call surfaces).
- ❌ No "rounded rectangle with thick colored border on one side" lazy accents (one match in `NodeShell` for builder canvas, which is a deliberate flow-chart node style — contextually appropriate).

**Tells that *are* present and worth calling out:**

- 🟡 Geist Sans / Mono as primary typeface is a *very* popular 2024–2025 AI default. It's a Vercel-aligned choice (the project ships on Vercel) so it's defensible, but it leans toward "generic polished SaaS" rather than a distinctive voice.
- 🟡 The QuickLinks grid on the dashboard (`1 sm:grid-cols-2 gap-2` of `icon + label + description` cards) approaches the icon-heading-text CTA grid template the skill flags as templated. Mitigated by varying accent colors per item and using `border-transparent → border-subtle` hover, but a more visually differentiated layout (mixed tile sizes, varied composition) would feel more designed.
- 🟡 Dashboard `IntelligenceGrid` renders 17 KPI cards as `StatCard`s — `icon + KPI label + small subtitle + trend chip`. This is the canonical "hero metric layout template" the skill warns about (big number, small label, supporting stats, gradient accent — minus the gradient). The cards are individually functional and information-dense, but the layout as a whole is the most templated section of the portal.
- 🟡 Hard-coded hex colors `#5B9EFF` / `#5FE5A8` / `#FFB547` / `#C084FC` / `#E879F9` appear in `settings/_components/analytics-tab.tsx` — these match tokens (`--accent`, `--terminal`, `--warning`, `--accent-purple`, stage colors) but are written as raw hex, breaking the token contract.
- 🟡 Sparkline (`streaming-sparkline.tsx`) is used as decoration on `StreamingMetricsCard` — the skill explicitly calls this out as a "tiny chart that looks sophisticated but conveys nothing meaningful." Worth verifying the sparkline actually encodes a trend the user needs vs. is purely atmospheric.

---

## Executive Summary

| Severity | Count | Theme |
|---|---|---|
| **Critical** | 0 | — |
| **High** | 5 | a11y gaps in 2 small surfaces + 1 nested-button bug + 2 theming-contract breaks |
| **Medium** | 9 | Hard-coded hex, ad-hoc z-index, missing image a11y on chart `<svg>`s, font choice, focus-trap edge cases, hero-metric grid pattern, sparkline decoration, alt-attribute pass on 1 `<img>` use, no-runtime verification gap |
| **Low** | 6 | Glass-card usage on auth surface, lucide icon-size drift, Tailwind `dark:` variants left over, `prefers-color-scheme: dark` absent (intentional but worth noting), 1 unused tokens, `border-l-[Xpx]` accent on builder nodes (justified, listed for completeness) |
| **Total** | **20** | |

**Overall quality score: 8.4 / 10.** This is a well-built portal with a clear design language, mature accessibility posture, and good engineering hygiene. The issues are real but mostly concentrated in two areas: (a) a few hard-coded hex values bypassing the token system, and (b) the dashboard's dense grid of "icon + KPI + trend" cards which feels templated compared to the rest of the surface.

**Most critical issues (top 5):**

1. **Hard-coded hex in `analytics-tab.tsx`** breaks the token contract in a setting that already establishes one elsewhere (the surrounding tab has full token discipline). Bypassing tokens creates a future re-themeing hole — a color swap in tokens would miss these.
2. **Nested `<button>` in `TranscriptView.tsx`** — the comment in the code *describes* the previous bug ("invalid HTML that browsers silently swallow") and the fix is in place, but the *fix* still uses a stop-propagation pattern around what is effectively two stacked buttons. Verify with `tsc --noEmit` and a lint rule that nested-interactive lint isn't disabled.
3. **Mobile touch-target contract** — the `globals.css` mobile-bump rule (`button:not(.no-bump)::before` extends hit area to 44×44) is excellent in principle, but only 0 components in the audit applied `.no-bump`. Verify the rule doesn't accidentally bump the icon-only buttons inside dense toolbars where the visual padding already meets WCAG but a hit area expansion would overlap neighbors.
4. **`prefers-color-scheme: dark` is never declared** — this is a dark-only design (intentional), but a `color-scheme: dark` declaration on `:root` would tell the browser to render native form controls / scrollbars / autofill in dark, eliminating the white-flash-when-autofilling-inputs glitch.
5. **No runtime a11y verification** — `package.json` lists `@axe-core/cli` and Playwright but there's no evidence in scripts that axe-core runs against built pages. The 76 frontend vitest pass count from prior audits is unit-only.

**Recommended next steps:**

1. Migrate `analytics-tab.tsx` hex literals to `var(--accent)` / `var(--terminal)` / `var(--warning)` / `var(--accent-purple)` / `var(--stage-archiving)`.
2. Add `color-scheme: dark` to `:root` in `globals.css`.
3. Add an `npm run audit:a11y` script using `@axe-core/cli` against the running dev server, gated to pass before `npm run build`.
4. Consider redesigning the dashboard's `IntelligenceGrid` to break the uniform-card pattern (mixed tile sizes, an inline chart hero, a featured metric).
5. Audit `<img>` use (1 instance) and `<svg>` chart accessibility (chart label semantics, aria-label or `<title>`).

---

## Detailed Findings by Severity

### Critical Issues

*None.* The portal has no WCAG-A blockers I could identify from static analysis. The contrast ladder, focus indicators, semantic landmarks, and keyboard navigation are all wired up. The one potential runtime concern (no axe scan in CI) is listed under Verification gaps below.

---

### High-Severity Issues

#### H1. Hard-coded hex literals bypass design tokens
- **Location:** `clients/portal/src/app/(portal)/settings/_components/analytics-tab.tsx:18-22` (and possibly other settings tabs)
- **Category:** Theming
- **Description:** `analytics-tab.tsx` declares its chart palette as raw hex strings: `"#5B9EFF"`, `"#5FE5A8"`, `"#FFB547"`, `"#C084FC"`, `"#E879F9"`. These duplicate values already defined as tokens (`--chart-primary`, `--chart-success`, `--chart-warning`, `--accent-purple`, `--stage-archiving`). A file comment partially acknowledges this: "Mismatches used to be (#ef4444 / #8b5cf6) which [had issues]".
- **Impact:** Any future theme change to those tokens is silently bypassed by this tab. The portal has 112+ design tokens precisely to avoid this. Mismatches also create subtle visual drift between the chart and the rest of the surface (e.g. if `--chart-primary` is later desaturated, this tab's chart stays at the old hue).
- **WCAG/Standard:** N/A (style quality, not a11y)
- **Recommendation:** Replace hex strings with `var(--chart-primary)` etc. via `getComputedStyle(document.documentElement).getPropertyValue('--chart-primary').trim()` (read once at module scope), or — better — read the tokens at the top of the file and pass them as CSS custom-property *strings* to recharts (`stroke="var(--chart-primary)"`).
- **Suggested command:** `/normalize` (replaces hex literals with token references; cross-checks all component files in one pass).

#### H2. Nested `<button>` pattern (clicks-eaten history)
- **Location:** `clients/portal/src/components/observability/TranscriptView.tsx` (around the expandable row chevron, line ~120)
- **Category:** Accessibility
- **Description:** The code has a *comment block* explaining "previous bug: invalid HTML that browsers silently swallow — clicks on the chevron never fired before this fix." The fix uses a `setExpanded` toggle button + `e.stopPropagation()` on the inner element. While the chevron now works, the broader pattern (an outer clickable row + an inner button) is fragile: it depends on `stopPropagation` for correctness and breaks if either element is wrapped in a Radix Portal.
- **Impact:** Browsers parse the markup; the inner button is silently promoted to a sibling by the HTML parser, but screen readers announce the relationship inconsistently. Future refactors that introduce a wrapper (e.g. a tooltip) can re-introduce the swallowed-click bug.
- **WCAG/Standard:** WCAG 4.1.2 (Name, Role, Value) — interactive elements must be programmatically determinable.
- **Recommendation:** Replace the outer row's `<div onClick>` with a `<button>` that contains the inner toggle as a *focusable child* (not a `<button>` — a `<span role="button" tabIndex={0}>`) OR move the row's click handler onto a clearly delineated primary action (a "View details" link at the row's right edge) and let the rest of the row be a passive surface.
- **Suggested command:** `/harden` (a11y hardening pass — converts div-buttons to button elements, restructures nested interactivity).

#### H3. Mobile touch-target expansion via `::before` — verify against dense toolbars
- **Location:** `clients/portal/src/app/globals.css` (~line 1265, the `max-width: 767px` rule)
- **Category:** Accessibility (mobile)
- **Description:** The rule bumps hit area to 44×44 for `button:not(.no-bump)::before`, `[role="button"]:not(.no-bump)::before`, `a[href]:not(.no-bump)::before`, `label:not(.no-bump)::before`. This is excellent for the broad case. **However**, on dense toolbars where buttons are already visually 44×44 (the toolbar row in `Inspector.tsx` and `builder/page.tsx` both use `size="icon"` for 10+ buttons), the invisible `::before` *expansion* could overlap the neighboring button's hit area, causing mis-taps.
- **Impact:** Users on mobile could tap the "intended" button and have the gesture land on a neighbor's hit region — silent UX bug, hard to attribute without instrumentation.
- **WCAG/Standard:** WCAG 2.5.8 (Target Size - Minimum, AA) — target size must be at least 24×24 CSS pixels; *Enhanced (AAA)* 2.5.5 requires 44×44. The expansion rule targets AAA but its application may be over-broad.
- **Recommendation:** Add an explicit test case to the mobile-touch-target policy: `button:not(.no-bump):not([data-density="dense"])::before`. The builder toolbar should mark its rows `data-density="dense"` and the CSS rule should honor it.
- **Suggested command:** `/adapt` (responsive-design pass — encodes the dense-toolbar exemption in CSS).

#### H4. Two `<div onClick>` overlays lack keyboard-close support
- **Location:**
  - `clients/portal/src/app/docs/page.tsx` (search overlay backdrop)
  - `clients/portal/src/app/(portal)/settings/_components/transfer-ownership-dialog.tsx` (dialog scrim)
- **Category:** Accessibility
- **Description:** Both files use a `<div className="absolute inset-0 bg-[var(--bg-base)]/50" onClick={...}>` as a dismiss surface. The docs page version has `role="presentation"` (decorative, correct). The transfer-ownership version has **no role**, **no `aria-hidden`**, **no `tabIndex`**, **no keyboard handler**. Keyboard users can't dismiss the dialog by pressing Escape — they have to find and click the "Cancel" button.
- **Impact:** Keyboard-only and screen-reader users have a degraded path: they can't dismiss the dialog as quickly as mouse users. The whole point of a scrim is uniform dismiss; if it doesn't dismiss for keyboard users, the affordance is broken for them.
- **WCAG/Standard:** WCAG 2.1.1 (Keyboard) — all functionality must be operable through a keyboard interface.
- **Recommendation:** Replace `<div onClick>` with a `<button>` styled as a scrim (full-bleed, transparent, `aria-label="Close dialog"`), OR add an explicit `onKeyDown` handler with `Escape` → `onClose()`. The cleaner pattern: use Radix Dialog (already in `components/ui/dialog.tsx`) which handles Escape + scrim click + focus trap correctly. The transfer-ownership dialog appears to *not* use the Radix primitive — a missed reuse.
- **Suggested command:** `/harden` (a11y hardening — converts ad-hoc overlays to Radix Dialog, adds keyboard handlers).

#### H5. `<button>` "Retry" links in error states
- **Location:** `clients/portal/src/app/(portal)/alerts/page.tsx` (line ~145: `<button onClick={fetchAlerts} className="ml-auto text-xs underline">Retry</button>`)
- **Category:** Accessibility
- **Description:** A "Retry" button styled as a 12px underlined text link inside the alerts error state. Using a `<button>` for what looks like a link is semantically fine, but the styling (text-xs underline, no padding, no visible focus ring by default) makes it hard to *discover* as interactive, especially on touch devices where the 12px font + 4px padding renders at ~16×20px — *below the AAA 44×44 target*.
- **Impact:** Users with low vision may not perceive the underlined text as clickable. Mobile users with motor difficulties may mis-tap.
- **WCAG/Standard:** WCAG 1.4.3 (Contrast — Minimum) and 2.5.5 (Target Size Enhanced).
- **Recommendation:** Either (a) bump font size to `text-sm`, add `min-h-[32px] px-3` and a subtle hover background to match the existing `<Button variant="link">` design tokens, or (b) adopt `<Button size="sm" variant="outline">Retry</Button>`. The existing Button component already supports a link-styled variant.
- **Suggested command:** `/normalize` + `/adapt` (replace ad-hoc button-text-link patterns with the existing `Button` primitives that already encode the a11y contract).

---

### Medium-Severity Issues

#### M1. Geist Sans / Mono as default typography is "popular AI choice"
- **Location:** `globals.css` (`@font-face` declarations via `next/font`, `font-family: var(--font-geist-sans)`)
- **Category:** Typography / visual identity
- **Description:** Geist is Vercel's font and is one of the most-recommended AI-default fonts of 2024–2025. It's a defensible choice (the project deploys to Vercel; Geist is optimized for that platform), but it leans the interface toward "generic polished SaaS" rather than the terminal/blueprint personality the rest of the design implies.
- **Impact:** The terminal/code aesthetic (phosphor-green accents, monospace labels, terminal mock windows) is undermined slightly by a font that doesn't lean into that voice. A monospace-forward display face like **Berkeley Mono**, **JetBrains Mono** for display + Geist for body, or **IBM Plex Sans + IBM Plex Mono** would lock in the technical aesthetic.
- **Recommendation:** Audit whether the brand identity is "Vercel-aligned SaaS" (current choice is correct) or "developer-tool-with-terminal-aesthetic" (consider a more characterful display face). Whatever the answer, lock it in via `font-display` token rather than letting it drift.
- **Suggested command:** `/typeset` (font audit + recommendation).

#### M2. Dashboard `IntelligenceGrid` is a hero-metric template
- **Location:** `clients/portal/src/app/(portal)/dashboard/_components/intelligence-grid.tsx`
- **Category:** Layout / visual identity
- **Description:** Renders 17 `StatCard`s, each structured `icon-chip + KPI label + value + trend chip + subtitle`. This is the canonical "big number, small label, supporting stats" template the frontend-design skill flags as templated. The cards are individually functional and information-dense, but the *layout as a whole* repeats the same composition 17 times.
- **Impact:** Users glaze over the grid — the visual rhythm doesn't help the eye find what matters. There's no featured metric, no inline chart, no varied tile size to anchor the most important data point.
- **Recommendation:** Restructure to **one featured tile (large, hero) + 4 secondary tiles (medium) + 8 micro-tiles (small)**. Use the featured slot for the metric with the highest signal-to-noise ratio (probably cost this month). The current structure treats every metric as equally important, which is exactly the problem hero grids solve.
- **Suggested command:** `/arrange` (layout / rhythm pass) + `/critique` (independent design review).

#### M3. QuickLinks grid approaches the icon-grid template
- **Location:** `clients/portal/src/app/(portal)/dashboard/_components/quick-links.tsx`
- **Category:** Layout / visual identity
- **Description:** 9 items, each `icon + label + description + arrow`, in a uniform 2-col grid. Each item is differentiated only by the accent color of its icon chip.
- **Impact:** The page feels templated at this section. The intent (jump-to-frequent-surface) is good but the execution is "Bootstrap icon grid."
- **Recommendation:** Vary the composition: 1 hero tile (e.g. "Observability") + 8 secondary. Or group by intent ("Build / Observe / Optimize / Admin") and use the grouping itself as a visual rhythm device.
- **Suggested command:** `/arrange` + `/bolder` (make it feel intentional rather than default).

#### M4. `Sparkline` may be decorative without informational value
- **Location:** `clients/portal/src/components/streaming-sparkline.tsx`, `clients/portal/src/components/observability/StreamingMetricsCard.tsx`
- **Category:** Performance / information design
- **Description:** Sparklines that are too small to read a meaningful trend (under 50px wide, <5 data points) are flagged by the skill as "looks sophisticated but conveys nothing meaningful." Need to verify the sparkline is communicating a useful trend (slope of last 5 minutes) and not just texture.
- **Impact:** If decorative, it's pure visual noise — adds file size + render cost + cognitive load without information. If informational, the implementation should label what it represents (p50/p95/last-5-min?).
- **Recommendation:** Audit `StreamingMetricsCard` — does the sparkline label itself? If not, either remove or label with `aria-label` and a legend.
- **Suggested command:** `/audit` (re-audit the sparkline specifically) or `/optimize` if removal is the answer.

#### M5. Hard-coded `dark:` Tailwind variants (legacy)
- **Location:** 17 files use `dark:` Tailwind variants (e.g. `dark:bg-zinc-900`, `dark:text-white`)
- **Category:** Theming / dead code
- **Description:** The portal is dark-mode-only — there's no `:root.light` block, no `prefers-color-scheme: light` media query, no theme toggle. Any `dark:` variant is dead code (the app is always dark) OR it's trying to *opt out* of dark mode in nested components, which is impossible without a light theme.
- **Impact:** Dead-code bloat (Tailwind must compile the variants even if unused at runtime). Misleading — readers think a light mode might exist.
- **Recommendation:** Grep for `dark:` and either delete or replace with explicit token references. A quick `rg 'dark:' --type tsx | wc -l` returned 17 matches; review each for legitimacy.
- **Suggested command:** `/normalize` (theming audit + cleanup).

#### M6. No `color-scheme: dark` declared on `:root`
- **Location:** `clients/portal/src/app/globals.css` (`:root` block, line ~14)
- **Category:** Theming / native rendering
- **Description:** `color-scheme: dark` tells the browser to render native controls (form inputs, scrollbars, autofill, `<select>`) in dark mode. Without it, autofill on a `<Input>` flashes white briefly on Android Chrome / iOS Safari, and `<select>` opens with native light styling. Adding `color-scheme: dark;` to `:root` is a one-line fix.
- **Impact:** Subtle but visible — every autofill event has a white flash on the affected field; every native `<select>` looks out of place.
- **WCAG/Standard:** N/A (UX polish)
- **Recommendation:** Add `color-scheme: dark;` to the `:root` block in `globals.css` immediately after the design-token comment header.
- **Suggested command:** `/harden` (UX resilience pass — native control theming).

#### M7. Ad-hoc z-index values (`z-[9999]`, `z-[100]`) bypass the documented ladder
- **Location:** 63 files use `z-[N]` arbitrary values; `globals.css` documents a ladder `--z-base` (0), `--z-sticky` (10), `--z-dropdown` (20), `--z-topbar` (30), `--z-modal` (40), `--z-overlay` (50).
- **Category:** Theming / z-index discipline
- **Description:** The grain overlay uses `z-index: 9999`, the command palette sometimes uses `z-[100]`. The CSS comments explain the z-distribution is documented — but the arbitrary values bypass it. When the next surface needs to sit above grain but below the command palette, there's no documented slot.
- **Impact:** Future stacking bugs. Anyone adding a new fixed overlay has to guess where to land.
- **Recommendation:** Either (a) expand the ladder (`--z-grain: 60`, `--z-tooltip: 70`, `--z-toast: 80`) and migrate the arbitrary values, or (b) enforce a lint rule that rejects `z-[N]` outside the ladder.
- **Suggested command:** `/normalize` (consolidate z-index discipline).

#### M8. No runtime a11y verification in CI
- **Location:** `clients/portal/package.json` — `@axe-core/cli` and `playwright` are installed but no `audit:a11y` script.
- **Category:** Accessibility (verification gap)
- **Description:** Static analysis (this audit) is necessary but insufficient. Runtime a11y issues — missing landmarks, label association failures, focus traps — only surface in a real browser. `@axe-core/cli` is installed but unused.
- **Impact:** The 76 vitest tests cover unit logic; no test ever asks "does Axe flag anything on /dashboard?" A future regression could ship a screen-reader-broken page without any CI signal.
- **Recommendation:** Add `"audit:a11y": "axe http://localhost:3000/dashboard http://localhost:3000/agents http://localhost:3000/pr-suggestions http://localhost:3000/observability --exit"` to package.json and run it as part of the pre-commit or pre-merge workflow.
- **Suggested command:** `/harden` (a11y verification — install the axe script + add to CI).

#### M9. `<img>` and chart `<svg>` accessibility
- **Location:** 1 `<img>` reference and many chart SVG components (Recharts)
- **Category:** Accessibility
- **Description:** Recharts-rendered SVG charts do not automatically expose `<title>` / `aria-label` / role="img". For dashboards / observability surfaces, this means screen-reader users hear "image" with no context.
- **Impact:** Sighted users get rich data viz; non-sighted users get a silent blank.
- **WCAG/Standard:** WCAG 1.1.1 (Non-text Content) — all non-text content must have a text alternative.
- **Recommendation:** Wrap Recharts `<ResponsiveContainer>` with a `<figure>` containing a `<figcaption>` (visible label like "Cost over last 30 days"), or pass `aria-label` to the underlying SVG. Recharts `ChartContainer` accepts an `accessibilityLayer` prop (Recharts 2.x).
- **Suggested command:** `/harden` (a11y hardening — chart label alternatives).

---

### Low-Severity Issues

#### L1. Lucide icon stroke-width drift
- **Location:** Components use icons with default stroke-width=2; some use `stroke-width={1.5}` or `stroke-width={1}` explicitly.
- **Category:** Visual consistency
- **Description:** Across 178 files importing from `lucide-react`, the stroke width is mostly default (2), with a handful using `stroke-1` or `stroke-1.5`. The `EmptyState` component explicitly sets `stroke-1` on its icon for the lighter "placeholder" feel.
- **Impact:** Inconsistent icon visual weight at the page level. Mostly invisible because the contexts differ, but in mixed-context views (e.g. icon list + chart legend), the weight difference is noticeable.
- **Recommendation:** Either standardize on one stroke width (2 is the Lucide default and what 90% of the code uses) OR define `--icon-stroke: 2` and `--icon-stroke-fine: 1.5` tokens and use them.
- **Suggested command:** `/normalize` (icon-stroke convention).

#### L2. `glass-panel` used on auth + command palette + dialog (4 surfaces)
- **Location:** `clients/portal/src/components/auth/auth-form-card.tsx`, `command-palette.tsx`, `dialog.tsx`, `wizard.tsx`
- **Category:** Visual identity
- **Description:** `backdrop-filter: blur(12px) saturate(140%)` is used on 4 surfaces. The skill's `don't` for glassmorphism says it's fine "purposefully rather than decoratively" — and this usage is purposeful (modals and overlays need to read as floating). The auth card is the borderline case — it's a translucent card on top of a brand panel; the glass effect is structural there, but it could be replaced with an opaque terminal-style card for a more distinctive feel.
- **Impact:** Mostly fine; the auth card is the one surface where the glass effect could be replaced for visual differentiation.
- **Recommendation:** Leave glass on dialog / command palette / wizard (they need to read as floating). On the auth card, consider an opaque terminal-style surface (e.g. `bg-[var(--bg-primary)] border-[var(--border-default)]` + a subtle terminal-green top accent line) to give the auth surface its own personality.
- **Suggested command:** `/bolder` (make auth surface feel distinct from the rest).

#### L3. 9 files use hard-coded `min-w-[Npx]` / `w-[Npx]`
- **Location:** Various (`marketing/page.tsx`, `analytics/page.tsx`, `pr-suggestions/page.tsx`, `builder/_components/...`)
- **Category:** Responsive
- **Description:** Fixed pixel widths work for terminal mocks and chart canvases but should be reviewed on mobile. Quick scan shows most are for chart axes (legitimate), a few are for sidebar widths (paired with `flex-shrink-0` so they're constrained, not breaking).
- **Impact:** Mostly fine; one or two may cause horizontal scroll on narrow viewports — verify with a `Responsive` audit at 320px width.
- **Recommendation:** Spot-check at 320px viewport. Fix any `min-w-[Xpx]` that doesn't have `min-w-0` companion.
- **Suggested command:** `/adapt` (mobile audit at 320px).

#### L4. Geist Mono may be over-deployed
- **Location:** 111 files use `font-mono`
- **Category:** Typography
- **Description:** The skill warns against "monospace typography as lazy shorthand for 'technical/developer' vibes." The portal uses mono for trace IDs, durations, code blocks, sparkline labels — all legitimate. But it's also used for `eyebrow` labels on `PageHeader` ("micro-labels") which doesn't carry semantic data; that one is borderline.
- **Impact:** None functionally; visually, mono-on-everything chips away at the "distinctive display face" goal.
- **Recommendation:** Use `font-sans uppercase tracking-widest` for PageHeader eyebrows (sans already exists in the eyebrow style); reserve mono for actual code/data.
- **Suggested command:** `/typeset`.

#### L5. `<svg>` inline icon stroke-width drift (continued from L1)
- **Location:** Builder canvas nodes (`NodeShell.tsx`) use `border-l-[2px]` (or similar) for status accent.
- **Category:** Visual consistency
- **Description:** The skill flags "rounded elements with thick colored border on one side" as a lazy accent pattern. The builder's `NodeShell.tsx` uses a left-border accent for the 8 node types. This is *justified* — flow-chart node status indicators are a recognized pattern (think Miro, Whimsical, n8n).
- **Impact:** None — contextually appropriate.
- **Recommendation:** No action; document the justification inline so future reviewers don't flag it again.

#### L6. Settings tab color literals (overlaps with H1)
- **Location:** Already covered by H1 above. Listed here for completeness of the theming-contract audit.

---

## Patterns & Systemic Issues

### Theming contract is well-established but inconsistently applied
The design-token system (`globals.css` 1398 lines, three tiers: primitive → semantic → component, 112+ tokens) is exemplary. The trouble spots are at the boundaries — components that import a value but write hex instead of `var(--token)`. The audit found:

- 10 hex literal occurrences in 3 files (`analytics-tab.tsx`, `optimization/page.tsx` chart fill `url(#fcBand)`, and 1 spot in the marketing page mock-data strings which are not real colors).
- 8 `rgba(` occurrences in components (chart palettes + custom gradients).
- 0 raw `rgb()` (good — only `rgba` for alpha needs).

The systemic recommendation: add an ESLint rule (`no-restricted-syntax` matching `Literal[value=/^#[0-9a-fA-F]{3,6}$/]` in `*.tsx`) and a CodeRabbit / lint warning when a hex appears outside `globals.css`. The portal already has a lint infrastructure (`polish:check`, `lint:portal-layout`, `lint:portal-classes`) — adding a `lint:portal-tokens` is a natural extension.

### Mobile a11y is *better than desktop*, by design
The `::before` hit-area expansion only applies at `max-width: 767px`. On desktop, the icon-only buttons in dense toolbars (Builder Inspector: 10+ `size="icon"` buttons) sit at 40×40px, *below* the AAA 44×44 target. This is intentional (the skill says dense toolbars should use the `.no-bump` opt-out — but the codebase doesn't use `.no-bump` anywhere). The systemic question: are desktop dense toolbars exempt from AAA, or do they need to ship larger hit areas?

Recommendation: Audit Builder Inspector at desktop width — if the hit areas are visually cramped, bump `size="icon"` to `size="default"` for toolbar rows. Alternatively, add a `dense` variant to the Button primitives.

### Heading hierarchy is excellent
- 22 pages use `<h1>` (one per page, good)
- 1 page (`docs/page.tsx`) has 4 `<h1>` matches — verify it's actually 4 H1s vs. one H1 + 3 H1-like search-result snippets
- `PageHeader` always emits `<h1>` — strong contract

### Focus indicator coverage
- `focus-visible` is used in 11 files
- `focus:` (legacy / always-on) is used in 80 files
- The CSS-level `:focus-visible` rule in `globals.css` catches everything that doesn't override it — strong default
- 17 files use `focus:ring-offset` — most components rely on the global ring-offset rule

The portal's a11y foundation is strong. The exceptions (M8: no runtime verification) are a CI gap, not a design gap.

---

## Positive Findings

Things that are *exemplary* and should be preserved through future changes:

- **`globals.css` design-token system.** Three-tier (primitive → semantic → component) with extensive inline rationale. Best-in-class for a Next.js project of this size.
- **`MotionProvider` with `reducedMotion="user"`.** Bridges framer-motion to OS preference correctly. The CSS-level `prefers-reduced-motion` rule covers everything else.
- **`PageHeader` and `PageContent` primitives.** The comment block on `page-content.tsx` describes a real past problem (31 hand-rolled wrappers had drifted) and the fix (one canonical wrapper) is the right architectural call. Future wrappers should always live in this directory.
- **Three-tier audit history in CSS comments.** The `:root` block has comments naming *every* prior bug (border-subtle contrast failure, text-muted contrast failure, sidebar dropdown edge invisibility) with the before/after values and the rationale. This is institutional memory encoded in the file.
- **`StatCard` aria-label on trend chip.** `"Up 12% (good)"` / `"Down 3% (bad)"` — exactly the right pattern for screen-reader announcement.
- **Skeleton + EmptyState + Loading + Error pattern.** Every state has a deliberate placeholder; no "blank page on load" anti-pattern anywhere I scanned.
- **`latency-card.tsx` budget ratio bar.** The card colors its latency bar based on `p95 / budgetMs` ratio (success / warning / error). Information density + visual feedback at once.
- **Custom `ChatSidebar` floating overlay** with explicit z-stack discipline and the `data-route="onboarding"` CSS guard preventing z-50 elements from eating wizard clicks. Real bug, real fix, documented inline.

---

## Recommendations by Priority

### Immediate (this session)

1. **H1.** Migrate `analytics-tab.tsx` hex literals to token references. 5 lines of code.
2. **M6.** Add `color-scheme: dark;` to `:root` in `globals.css`. 1 line.
3. **H4.** Add Escape handler to `transfer-ownership-dialog.tsx` scrim OR migrate to Radix Dialog primitive. ~10 lines.

### Short-term (this sprint)

4. **M8.** Add `npm run audit:a11y` script using `@axe-core/cli` against built pages. ~15 lines + a CI workflow step.
5. **H5.** Replace ad-hoc "Retry" text-buttons with `<Button variant="outline" size="sm">` in `alerts/page.tsx` (and audit other 4 files with the same pattern).
6. **M9.** Add chart label alternatives (figcaption or aria-label) to Recharts containers in dashboard + observability + cost surfaces.
7. **H2.** Verify the nested-button fix in `TranscriptView.tsx` against future lint rules; consider restructuring as link + chevron button.

### Medium-term (next sprint)

8. **M2 + M3.** Redesign dashboard `IntelligenceGrid` + `QuickLinks` to break the uniform-card-grid template (1 hero + varied sizes + grouping).
9. **H3.** Add `data-density="dense"` opt-out for the mobile touch-target expansion in dense toolbars; audit Builder Inspector at 320px.
10. **M7.** Expand z-index ladder to documented values; remove all `z-[N]` arbitrary values.

### Long-term (next quarter)

11. **M1.** Typography review — commit to a display face that aligns with the terminal/blueprint personality (or formally acknowledge Geist as the deliberate choice).
12. **M5.** Remove or token-replace all `dark:` Tailwind variants (17 files).
13. **L2.** Consider replacing glass auth card with opaque terminal-style surface for visual differentiation.
14. **L1 + L4.** Standardize icon stroke width and mono-vs-sans usage; document in design-system page.

---

## Verification gaps

This audit was static-only. The following issues **could not be assessed** from file inspection alone and warrant runtime verification:

- **No Axe scan ran.** `@axe-core/cli` is installed but no script invokes it. The 20 issues above are the ones I could *see*; runtime a11y violations (landmark gaps, label association failures, focus traps) are invisible to grep.
- **No browser testing.** Mobile rendering, touch-target overlap, autofill flashes, native form-control theming — all need a real browser at 320px / 768px / 1024px / 1440px.
- **No light-mode contrast verification.** Not relevant (the portal is dark-only) but worth confirming no future contributor accidentally introduces a light-theme path.
- **No interactive screenshot review.** The "feels templated" verdicts (M2, M3) are design opinions — a designer looking at the rendered dashboard may agree or disagree.

**Recommendation:** After applying the Immediate + Short-term fixes, run `@axe-core/cli` against `/dashboard`, `/agents`, `/pr-suggestions`, `/observability`, `/settings`, `/billing`, and the marketing page. Any Critical or Serious findings should be promoted into this audit's H column.

---

## Anti-patterns summary table

| Anti-pattern | Status | Notes |
|---|---|---|
| AI color palette (cyan-on-dark, neon) | ✅ Pass | Accent is desaturated blue + phosphor green, purposeful |
| Gradient text on metrics | ✅ Pass | Zero `bg-clip-text` usage |
| Glassmorphism everywhere | ✅ Pass | 4 surfaces, all purposeful (modal/palette/wizard/auth) |
| Hero metric layout template | 🟡 Partial | Dashboard IntelligenceGrid + QuickLinks are templated |
| Card grids (icon + heading + text) | 🟡 Partial | QuickLinks leans templated; rest of portal uses cards with varied composition |
| Generic fonts (Inter, Roboto) | 🟡 Watch | Geist is Vercel-aligned but trending AI-default |
| Bounce/elastic easing | ✅ Pass | Zero matches; reduced-motion handled |
| Layout-affecting animations | ✅ Pass | Zero `transition-(width|height|padding|margin)` |
| Nested cards | ✅ Pass | 4 files, all justified tool-call / streaming surfaces |
| Sparklines as decoration | 🟡 Verify | `streaming-sparkline.tsx` may be informational or atmospheric — audit |
| Thick colored border on one side (lazy accent) | ✅ Pass | Only match is builder NodeShell — contextually appropriate |
| Modals as lazy option | ✅ Pass | `dialog.tsx` uses Radix (correct a11y); ad-hoc overlays are rare |

**Overall AI-slop test: Pass.** A reviewer looking at the rendered portal would not say "AI made this" — the design language is opinionated, the token system is mature, and the implementation carries evidence of deliberate iteration. The dashboard section is the only place where the layout leans toward "templated," and that's a localized issue, not a systemic one.

---

*End of audit.*
