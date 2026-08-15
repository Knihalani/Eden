# Wave 3/4 — Eden Portal Density Rules

**Agent:** `w4-density-rules` (refresh of `w3-web-density-rules`)  
**Date:** 2026-07-20  
**Status:** Wave 4 refresh — binding with anti-clutter  
**Mode:** Docs only (no product UI)  
**Inputs:** [`w2-web-ux-standards.md`](./w2-web-ux-standards.md), [`w2-datadog-llm.md`](./w2-datadog-llm.md), [`w2-competitor-pattern-library.md`](./w2-competitor-pattern-library.md) P0-10, [`w1-density-grep.md`](./w1-density-grep.md), [`w1-token-audit.md`](./w1-token-audit.md), [`w1-consolidated-inventory.md`](./w1-consolidated-inventory.md), [`w4-anti-clutter-contract.md`](./w4-anti-clutter-contract.md)

**Normative for:** U19 Density program · Wave 5 class lint · Home / hub / instrument remediations · Wave 10 crowding TOP-5

---

## 0. Verdict

Density is a **surface role**, not a global skin. Overview and hub chrome **breathe**; analysis / instrument panels may pack. Ban casual `text-[9px]` / `text-[10px]`; allow mono micro-labels only via `--font-size-2xs` / `--font-size-3xs`. Layout uses an **8px grid** (4px sub-grid). Overview ships **5–7** primary metrics (desktop); **3–4** on mobile.

---

## 1. Density roles

| Role | Surfaces | Chrome bands | Type floor | Spacing | Dense OK? |
|---|---|---|---|---|---|
| **Overview** | `/dashboard` Home; Insights banner strips; KPI Status zones | ≤1 page band under AppShell | Body / labels ≥ `text-xs` (12px). No 9–10px on KPI chrome | 8px multiples; card/section gutters ≥ `--space-3` | **No** — sectioned KPI + charts |
| **Hub chrome** | Traces / Issues / Alerts / Agents / Evals / Improve / Settings identity + toolbar | ≤2 bands: identity/tabs + sticky filters | Nav, tabs, filters, primary lists ≥ `text-xs`. Secondary meta may use `text-2xs` | Toolbar `gap`/`py` on 4/8px; no `py-0.5` on chrome | **No** for chrome; list rows may Compact |
| **Explorer body** | Trace/issue/alert tables; InfiniteDataTable rows | Thin toolbar (see hub); density in rows | Primary cell ≥ `text-xs`; secondary meta `text-2xs` OK | Compact row height via `data-density`; gutters increase when rows densify | **Yes, calibrated** — dense rows, thin chrome |
| **Instrument / analysis** | `TranscriptView`, `TraceDetailPanel`, transcript-v2 lanes, query / time-travel / replay / debugger leaves | Panel-local only (not page lasagna) | `text-2xs` / `text-3xs` OK for mono micro-labels; body still ≥ `text-xs` | `p-1` / compact gaps OK inside panel | **Yes** — keep density; tokenize; do not flatten to hub spacing |
| **AI rail** | `ChatSidebar` (+ FAB / sheet / aside) | Sibling of `main`; not a page band | Chat chrome ≥ `text-xs`; citations may use `text-2xs` | Comfortable default; Compact does not shrink rail CTAs below touch floor | **Medium** — calm chrome; dense citations only |

### Role test (Datadog calibration)

> If removing micro-type / `py-0.5` makes RCA harder → **instrument** (keep density, use tokens).  
> If removing them improves scan → **overview / hub** (breathe; ban instrument skin).

### Role tags for remediation

Every density fix PR tags the file: `overview` | `hub-chrome` | `explorer` | `instrument` | `ai-rail`. Wave 1 hotspot score alone does not set fix order — **wrong-role micro on hubs outranks high-score instrument files for “breathe” work**.

---

## 2. Micro-classes: allowed vs banned

### 2.1 Banned (casual / fake density)

| Pattern | Wave 1 count | Rule |
|---|---:|---|
| `text-[9px]` | 5 | **Banned** everywhere as raw arbitrary. Replace with `text-3xs` (token) only under §2.3 gate |
| `text-[10px]` | 256 | **Banned** as raw arbitrary on shell, hubs, overview, lists. Instrument: migrate to `text-2xs` |
| `text-[11px]` | 115 | **Banned** as raw arbitrary. Prefer `text-xs` (12px) or `text-2xs` if micro-label gate applies |
| `py-0.5` / `gap-0.5` on overview + hub chrome | 148 / 17 | **Banned** off-grid 2px rhythm on Status / chrome. Use `py-1` (4px) min or token ladder |
| `leading-none` + micro type | 0 colocated today | **Banned** pairing — keep micro line-height ≥ token LH |

### 2.2 Allowed (tokenized)

| Utility / token | Value | Use |
|---|---|---|
| `text-xs` | 12px (TW default) | Default UI chrome, labels, table primary cells |
| `text-sm`+ | ≥14px | Titles, KPI values, body |
| `text-2xs` → `--font-size-2xs` | 0.625rem (10px) | **Gated** mono / secondary meta only (§2.3) |
| `text-3xs` → `--font-size-3xs` | 0.5625rem (9px) | **Gated** mono micro-labels only (§2.3) |
| `py-1` / `gap-1` | 4px | Compact sub-grid (icons, chip internal) |
| `py-2` / `gap-2`+ | 8px+ | Layout grid |

**Today:** `--font-size-2xs` / `3xs` exist in `:root` + `@theme`, but **0** `text-2xs` / `text-3xs` class hits — pages still use arbitrary px (`w1-token-audit`). Wave 4 migrates; does not invent new size names.

### 2.3 Micro-label gate (`2xs` / `3xs`)

Allowed **only** when all are true:

1. Surface role = `instrument` | `explorer` secondary meta | `ai-rail` citation chips.  
2. Typeface = **mono** (`font-mono`) **or** non-interactive badge/chip meta (not primary CTA label, not nav, not KPI title).  
3. Class is token utility (`text-2xs` / `text-3xs`), never `text-[9px]` / `text-[10px]`.  
4. Contrast meets WCAG AA against background.  
5. Not used to fake Compact on overview/hub chrome.

**Forbidden examples:** KPI card labels at 10px; Alerts hub row titles at 10px; `portal-chrome` nav at 9–10px; Home widget captions at 10px.

---

## 3. 8px grid + spacing ladder

| Rule | Detail |
|---|---|
| **Primary grid** | Layout spacing on **8px** multiples |
| **Sub-grid** | Icons, compact gaps, type rhythm on **4px** |
| **Token ladder (Wave 4)** | `--space-1`…`--space-8` = 4 / 8 / 12 / 16 / 24 / 32 / 40 / 48 (extend as needed). Map into `@theme` |
| **Present today** | Only `--space-2/3/4` (8/12/16); **0** component `var(--space-*)` outside `globals.css` |
| **Off-grid ban** | New `py-0.5` (2px) requires PR exception tag `density-exception: off-grid` + role = instrument |
| **Density equilibrium** | Compact may shrink **row/control height** by 4/8px steps; must **not** shrink type below `text-xs` for readable UI or shrink touch chrome below §6 floors |

---

## 4. Comfortable vs Compact defaults

| Surface | Default | Compact allowed? | Notes |
|---|---|---|---|
| **AppShell / sidebar / sticky header / mobile bottom nav** | Comfortable | Visual compact of nav OK; **not** type &lt; `text-xs`; touch ≥44px mobile chrome | `portal-chrome` is overview-class chrome |
| **Home /dashboard** | Comfortable | User may Compact tables inside widgets only | Overview breathes; KPI budget §5 |
| **Observe explorer tables** (Traces, Issues, Alerts lists) | **Compact** (rows) | Yes — default Compact for scan | Chrome stays Comfortable / thin (≤2 bands) |
| **Evals / Improve / Agents hub chrome** | Comfortable | Compact body tables OK | No instrument micro on hub chrome |
| **Instrument panels** (`TranscriptView`, detail pane) | Compact (panel-local) | Always dense-capable | Independent of shell Comfortable/Compact when possible (U19 surface classes) |
| **AI rail** | Comfortable | Compact optional for message list | CTAs / composer ≥ touch floor |
| **Settings** | Comfortable | Compact unused for forms | Identity chrome once; no micro-type hygiene debt |

**Global toggle:** `DensityProvider` `comfortable` \| `compact` remains. U19 adds **surface density classes** (`overview` | `explorer` | `instrument`) so Compact on Observe does not force instrument skin onto Home.

**Compact must not:**

- Drop readable UI below `text-xs`
- Shrink primary / mobile CTAs below 24px (WCAG 2.5.8) / 44px mobile chrome
- Introduce `text-[9px]` / `text-[10px]` as the Compact mechanism

---

## 5. Overview KPI budget

| Viewport | Primary metrics | Rule |
|---|---|---|
| Desktop (≥`lg`) | **5–7** (prefer **5**) | Default Home widgets trimmed/ranked to budget. `traces` / `links` count unless demoted to utility row below Status |
| Mobile (&lt;`lg`) | **3–4** | Overflow behind “More metrics” / snap / drill-in |

**Wave 1 gap:** `DEFAULT_WIDGETS` = **8** peer items — over budget.

**SDA:** Status (glance &lt;5s) → Diagnosis → Action. No diagnosis chrome above Status. Every Status tile links to diagnosis or action.

---

## 6. Touch / a11y floors (density-adjacent)

| Control class | Floor |
|---|---|
| Mobile shell chrome / primary touch | **44×44** CSS px |
| WCAG 2.2 AA absolute | **24×24** (2.5.8) |
| Improve / hub primary actions | Prefer ≥`h-8` (32); mobile primary ≥44 |
| Instrument opt-out | Explicit `data-density="dense"` for rare micro controls inside panels — not hubs |

Sticky header + bottom nav must not fully obscure focus (WCAG **2.4.11**).

---

## 7. Hotspot remediation order

Order = **wrong-role first**, then shell, then gated instrument tokenize. Scores from [`w1-density-grep.md`](./w1-density-grep.md).

| Order | File | Score | Role | Action |
|---:|---|---:|---|---|
| **1** | `components/observability/TranscriptView.tsx` | 86 | **instrument** | Keep density. Migrate `text-[9/10/11px]` → `text-2xs`/`3xs`/`xs`. Fix nested interactive (AUDIT H2). Do **not** breathe to hub spacing |
| **2** | `app/(portal)/alerts/page.tsx` | 62 | **hub** (wrong role) | Strip instrument micro; labels ≥ `text-xs`; replace `py-0.5`; calm ops-hub skin |
| **3** | `app/(portal)/portal-chrome.tsx` | 40 | **shell / overview** | Ban 9–10px nav/meta; fix `h-5`/`h-6` touch-hostile controls; Comfortable chrome |
| **4** | `app/(portal)/studio/page.tsx` | 54 | **hub / leaf** | Kill raw accent `<button>`×6; migrate micro-type; use `Button` |
| **5** | `components/ai-insights/ChatSidebar.tsx` | 6 | **ai-rail** | Low severity — lock floors (`text-xs` chrome, touch); citations may use `text-2xs` |

### Parallel batch (same wave as hub breathe)

| File | Score | Action |
|---|---:|---|
| `guardrails/page.tsx` | 70 | Hub breathe (same as alerts) |
| `ApprovalCard.tsx` | 63 | Insights card — demote micro; overview-adjacent |
| `fleet/page.tsx` | 43 | Hub breathe |
| `replay` / `query` / `time-travel` | 44–43 | **instrument** — tokenize, don’t undensify |
| `TraceDetailPanel.tsx` | 26 | **instrument** — with TranscriptView |

**P0-10 mapping:** Home/hub chrome = calm tokens; TranscriptView / TraceDetailPanel = instrument OK after token migrate ([`w2-competitor-pattern-library.md`](./w2-competitor-pattern-library.md) P0-10).

---

## 8. Wave 4 lint gate — `lint:portal-classes`

**Existing:** `clients/portal/scripts/lint-portal-classes.cjs` bans hardcoded `text-white` / `bg-black` / `text-gray-*` / `text-blue-*` / `bg-blue-*` under `(portal)/` + `components/`.

**Extend (Wave 4 recommendations):**

| Gate ID | Pattern | Severity | Allowlist |
|---|---|---|---|
| **D1** | `text-\[9px\]` | **error** | None — must be `text-3xs` |
| **D2** | `text-\[10px\]` | **error** | None — must be `text-2xs` or `text-xs` |
| **D3** | `text-\[11px\]` | **error** | None — `text-xs` or `text-2xs` |
| **D4** | `text-2xs` / `text-3xs` outside allowlist paths | **error** | Paths tagged instrument/explorer-meta: `TranscriptView`, `transcript-v2/**`, `TraceDetailPanel`, span I/O, mono `CodeChip`-class, AI citation chips |
| **D5** | `py-0.5` / `gap-0.5` under overview + hub page chrome | **warn→error** | Instrument panels + explicit exception comment |
| **D6** | New raw accent `<button` + `bg-[var(--accent)]` | **error** | Use `Button` (existing CTA drift; studio hotspot) |

**CI:** Wire into portal-ci (today class/layout lints are **local only** per inventory). Pair with `lint:portal-layout` + `polish:check`.

**Migration script (optional):** codemod `text-[10px]` → `text-2xs`, `text-[9px]` → `text-3xs`, then D4 trims wrong-role usages.

---

## 9. Measurable acceptance

| ID | Criterion | Measure |
|---|---|---|
| **A1** | Overview readable in **&lt;5s** | Home Status answers “is it OK?” without scrolling past KPI wall; ≤7 primary metrics desktop / ≤4 mobile |
| **A2** | No raw `text-[9px]` / `text-[10px]` / `text-[11px]` on shell | `portal-chrome.tsx` + AppShell chrome: **0** matches; CI D1–D3 |
| **A3** | No raw micro-px on hub chrome | Alerts / guardrails / fleet / studio hub chrome: **0** `text-[9|10|11px]`; labels ≥ `text-xs` |
| **A4** | Instrument micro is tokenized | TranscriptView + TraceDetailPanel: **0** arbitrary 9/10/11px; micro only via `text-2xs`/`3xs` under gate |
| **A5** | 8px rhythm on new chrome | New overview/hub spacing uses token ladder / 4–8px utilities; no new `py-0.5` without exception |
| **A6** | KPI budget | `DEFAULT_WIDGETS` visible primary ≤7 (prefer 5); documented demotions for utility widgets |
| **A7** | Traces chrome | ≤2 page bands (identity/tabs + sticky filters) — density fails before list if violated |
| **A8** | Lint green | Extended `lint:portal-classes` D1–D4 **error** in CI for portal paths |
| **A9** | Touch | Mobile primary chrome ≥44px; no new hub `h-5` icon-only primary actions |

---

## 10. Anti-patterns (do not ship)

| Anti-pattern | Fix |
|---|---|
| Instrument skin on overview/hubs | Role gate + breathe remediations §7 |
| Fake density via 9–10px type | Tokens + lint D1–D3 |
| Flattening TranscriptView to dashboard spacing | Classify instrument; tokenize only |
| KPI wall (&gt;7 peer tiles) | Budget §5 |
| Chrome lasagna (3+ bands) | Explorer thin chrome (P0-1 / Datadog R3) |
| Global Compact as only lever | Surface classes `overview` \| `explorer` \| `instrument` |
| Off-grid `py-0.5` as product-wide habit | 8px/4px ladder |

---

## 11. Source map

| Rule | Primary evidence |
|---|---|
| Overview vs analysis | `w2-datadog-llm` R1–R6, P0-1…P0-5; pattern library P0-10 |
| 8px grid · KPI 5–7 · type floor | `w2-web-ux-standards` S1, S2, S6, S7 |
| Hotspots · counts | `w1-density-grep` §1–5 |
| Tokens `2xs`/`3xs` unused | `w1-token-audit` §3; inventory §5.2 |
| Shell / density attr | inventory §2, §5 |

---

## 12. Wave 4 handoff checklist

- [ ] Implement spacing ladder + `@theme` utilities (`space-1`…`space-8`)
- [ ] Extend `lint:portal-classes` with D1–D6; enable in portal-ci
- [ ] Remediate §7 order 1–5 (+ parallel hub breathe batch)
- [ ] Trim Home `DEFAULT_WIDGETS` to ≤7 primary
- [ ] U19: surface density classes + optional `--density-*` 4px steps
- [ ] Collapse Traces to ≤2 bands (chrome density before content density)

---

*End of Wave 3 density rules.*
