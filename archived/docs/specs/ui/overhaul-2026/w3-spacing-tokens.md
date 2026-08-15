# Wave 3/4 — Spacing & Type Token Spec

**Agent:** `w4-spacing-tokens` (refresh of `w3-spacing-token-spec`)  
**Date:** 2026-07-20  
**Status:** Wave 4 refresh — **implement in Wave 5** `w5-spacing-tokens` (docs only this wave)  
**Scope:** Docs only. Propose tokens for Wave 5 — **do not** edit `globals.css` in Wave 4 contracts.  
**Brand constraint:** Keep dark-terminal color / shadow / radius tokens unchanged. This spec expands **spacing + type scale only**.

**Inputs:** [`w1-token-audit.md`](./w1-token-audit.md) · [`w1-density-grep.md`](./w1-density-grep.md) · [`w2-web-ux-standards.md`](./w2-web-ux-standards.md) · [`w2-linear-stripe-chrome.md`](./w2-linear-stripe-chrome.md) · [`w4-anti-clutter-contract.md`](./w4-anti-clutter-contract.md) · `clients/portal/src/app/globals.css` (read-only)

**Breathing ladder:** Overview/hub chrome uses `--space-4+` gutters; analysis stays dense via tokens — not by packing header controls ([anti-clutter](./w4-anti-clutter-contract.md) §7).

---

## 1. Current state

### 1.1 Spacing (incomplete)

| Token | Value | px @ 16 | In `@theme` | Component use |
|-------|-------|--------:|:-----------:|---------------|
| `--space-2` | `0.5rem` | 8 | no | globals only |
| `--space-3` | `0.75rem` | 12 | no | globals only |
| `--space-4` | `1rem` | 16 | no | globals only |

**Missing:** `--space-1`, `--space-5`…`--space-8` (and any larger section steps).  
**Call sites:** 5 `var(--space-*)` refs, all inside `globals.css` (pre, inputs, skip-link). Components use Tailwind `p-*` / `gap-*` / `py-0.5` — not the token ladder.  
**Density:** `[data-density="compact"]` attribute CSS only; **0** `--density-*` vars.

### 1.2 Type (partial tokens + arbitrary abuse)

| Token | rem | px | Notes |
|-------|-----|---:|-------|
| `--font-size-3xs` | `0.5625rem` | 9 | In `@theme`; **0** `text-3xs` class hits |
| `--font-size-2xs` | `0.625rem` | 10 | In `@theme`; **0** `text-2xs` class hits |
| `--font-size-sm`…`4xl` | 0.875–2.25rem | 14–36 | Defined in `:root`; **not** in `@theme` (TW defaults) |
| Line heights | tight 1.25 / normal 1.5 / relaxed 1.625 | — | `--line-height-normal` unused |
| Letter spacing | tight / normal | — | `--letter-spacing-tight` unused |

**Density grep (P0):** `text-[10px]`×256 · `text-[11px]`×115 · `text-[9px]`×5 · `py-0.5`×148 · `gap-0.5`×17.  
Tokens `2xs`/`3xs` already exist but components still hardcode arbitrary sizes.

### 1.3 Layout rhythm today (hardcoded rem)

| Surface | Current classes | Approx |
|---------|-----------------|--------|
| `PageContent` | `px-4 py-4 sm:px-6 sm:py-5 lg:px-10 lg:py-6` + `space-y-5` | 16/16 → 24/20 → 40/24; stack 20 |
| `ResourcePageShell` | `gap-4` between header/toolbar/table | 16 |
| `FilterBar` | `gap-3 p-3` | 12 / 12 |
| Sticky header | `h-11` | 44 (keep — touch floor) |

---

## 2. Proposed `--space-1`…`--space-8`

**Grid:** 4px base, 8px primary layout beat (Material / Linear / Stripe Apps / W2 S1).  
**Root:** `1rem = 16px`. Values are exact rem; px column is the design intent.

| Token | rem | px | Grid role | Typical use |
|-------|-----|---:|-----------|-------------|
| `--space-1` | `0.25rem` | **4** | 4px sub-grid | Icon inset, compact chip pad, hairline stack |
| `--space-2` | `0.5rem` | **8** | primary step | Control pad-x, tight inline gap *(existing)* |
| `--space-3` | `0.75rem` | **12** | half-step | Filter control gap, dense row pad *(existing)* |
| `--space-4` | `1rem` | **16** | layout unit | Section inner pad, shell slot gap *(existing)* |
| `--space-5` | `1.5rem` | **24** | layout ×1.5 | PageContent sm+ horizontal / vertical |
| `--space-6` | `2rem` | **32** | layout ×2 | Page section gap, KPI strip → table |
| `--space-7` | `2.5rem` | **40** | layout ×2.5 | PageContent lg horizontal pad |
| `--space-8` | `3rem` | **48** | section | Major hub section break, empty-state air |

**Do not add** off-grid tokens (`2px`, `10px`, `20px`) as named `--space-*`. Map Tailwind `0.5` (2px) → nearest on-grid (`space-1` or ban).

**Optional later (Wave 4+ P2, not required for `--space-1`…`8`):** `--space-9: 4rem` (64) for marketing/legal hero only — out of portal product scope.

**`:root` proposal (Wave 4 implements):**

```css
/* Spacing System — 4px base, 8px primary (complete ladder) */
--space-1: 0.25rem; /* 4 */
--space-2: 0.5rem;  /* 8  — keep */
--space-3: 0.75rem; /* 12 — keep */
--space-4: 1rem;    /* 16 — keep */
--space-5: 1.5rem;  /* 24 */
--space-6: 2rem;    /* 32 */
--space-7: 2.5rem;  /* 40 */
--space-8: 3rem;    /* 48 */
```

---

## 3. Type scale tokens vs banned arbitrary sizes

### 3.1 Canonical product type ladder

| Token | rem | px | Allowed roles | Default surfaces |
|-------|-----|---:|---------------|------------------|
| `--font-size-xs` **(new)** | `0.75rem` | **12** | Smallest **readable** UI chrome | Badges, table meta, filter chips, secondary labels |
| `--font-size-sm` | `0.875rem` | 14 | Body secondary / controls | Inputs, nav items, table cells |
| `--font-size-base` | `1rem` | 16 | Body primary | Page prose, form labels |
| `--font-size-lg` | `1.125rem` | 18 | Emphasized body / section lead | Empty-state title support |
| `--font-size-xl` | `1.25rem` | 20 | Page section title | Hub subheads |
| `--font-size-2xl` | `1.5rem` | 24 | Page H1 (compact hubs) | `PageHeader` title |
| `--font-size-3xl` | `1.875rem` | 30 | Rare page hero | Marketing / legal only in portal |
| `--font-size-4xl` | `2.25rem` | 36 | Marketing | Marketing only |

### 3.2 Micro tokens — restricted, not default density

| Token | rem | px | Status after overhaul |
|-------|-----|---:|------------------------|
| `--font-size-2xs` | `0.625rem` | 10 | **Restricted:** mono + uppercase + tracking meta labels only (PageHeader eyebrow, terminal mock chrome). Prefer `--font-size-xs` elsewhere. |
| `--font-size-3xs` | `0.5625rem` | 9 | **Restricted:** terminal mock windows / decorative chrome only. Never product UI chrome. |

### 3.3 Banned arbitrary sizes (product UI)

| Pattern | Hits (W1) | Migration |
|---------|----------:|-----------|
| `text-[9px]` | 5 | → `text-3xs` **only** if mock/decorative; else `text-xs` |
| `text-[10px]` | 256 | → `text-2xs` (meta/mono) or **`text-xs`** (default UI) |
| `text-[11px]` | 115 | → `text-xs` (12px) — no 11px token |
| `text-[Npx]` / `text-[Nrem]` outside ladder | — | ban |

**Comfortable default rule (W2 S7):** Compact density may shrink **row height** by 4/8px; it may **not** drop readable UI below `text-xs` (12px) or shrink primary touch chrome.

### 3.4 Line height / tracking (keep; wire usage)

| Token | Value | Use |
|-------|-------|-----|
| `--line-height-tight` | 1.25 | Titles, table dense rows |
| `--line-height-normal` | 1.5 | Body (align body `line-height` to this; today body uses 1.55) |
| `--line-height-relaxed` | 1.625 | Long-form / empty states |
| `--letter-spacing-tight` | -0.025em | Display titles |
| `--letter-spacing-normal` | 0 | Default |
| *(new)* `--letter-spacing-wide` | `0.05em` | Optional for uppercase `2xs` meta labels |

---

## 4. Tailwind `@theme` mapping (Wave 4)

Register spacing so utilities consume tokens (today: **0** spacing `@theme` entries).

```css
@theme inline {
  /* Spacing → p-space-*, m-space-*, gap-space-*, etc. */
  --spacing-space-1: var(--space-1);
  --spacing-space-2: var(--space-2);
  --spacing-space-3: var(--space-3);
  --spacing-space-4: var(--space-4);
  --spacing-space-5: var(--space-5);
  --spacing-space-6: var(--space-6);
  --spacing-space-7: var(--space-7);
  --spacing-space-8: var(--space-8);

  /* Type — map full ladder (not only 2xs/3xs) */
  --font-size-3xs: var(--font-size-3xs);
  --font-size-2xs: var(--font-size-2xs);
  --font-size-xs: var(--font-size-xs);     /* NEW */
  --font-size-sm: var(--font-size-sm);
  --font-size-base: var(--font-size-base);
  --font-size-lg: var(--font-size-lg);
  --font-size-xl: var(--font-size-xl);
  --font-size-2xl: var(--font-size-2xl);
  --font-size-3xl: var(--font-size-3xl);
  --font-size-4xl: var(--font-size-4xl);
}
```

**Utility preference (new code):**

| Prefer | Avoid |
|--------|-------|
| `gap-space-4`, `p-space-3`, `px-space-5` | Ad-hoc `gap-[14px]`, `py-0.5` |
| `text-xs` / `text-sm` / `text-2xs` | `text-[10px]`, `text-[11px]` |
| Existing TW `gap-4` (=16) OK during migrate if equal to `--space-4` | Mixing random rem steps in one stack |

**Compat:** Keep standard TW spacing (`p-4`, `gap-4`) valid — they already land on 4/8 grid. Goal is token completeness + banning off-grid / micro-type, not forbidding all TW numeric utilities on day one.

---

## 5. Comfortable default rhythm

Targets for overview / hubs (breathe). Analysis panels (transcript, span tree) may stay denser **via density mode**, not via 9–10px type.

### 5.1 `PageContent`

| Breakpoint | Padding (token) | Stack (`space-y`) |
|------------|-----------------|-------------------|
| default | `px-space-4 py-space-4` (16) | `space-y-space-5` (24) — replace today's `space-y-5` (20→24 on-grid) |
| sm+ | `px-space-5 py-space-5` (24) | same |
| lg+ | `px-space-7 py-space-6` (40 / 32) | same |

**Proposed class string (Wave 4):**  
`px-space-4 py-space-4 sm:px-space-5 sm:py-space-5 lg:px-space-7 lg:py-space-6 space-y-space-5`

Embedded mode: keep `space-y-space-5`, no outer pad.

### 5.2 `ResourcePageShell`

| Slot relationship | Gap |
|-------------------|-----|
| header → toolbar → kpi → table | `gap-space-4` (16) — keep current beat |
| table ↔ detail (lg row) | `gap-space-4` horizontal (add if missing) |
| After KPI strip before table | Prefer `gap-space-5` (24) when KPI present — optional `data-has-kpi` variant |

Keep PageHeader `mb-4` collapse (`[&_.mb-4]:mb-0`) so shell owns vertical rhythm.

### 5.3 Filters (`FilterBar` / `QueryFilterBar`)

| Element | Token |
|---------|-------|
| Bar padding | `p-space-3` (12) — keep |
| Control gap | `gap-space-3` (12) — keep |
| Sticky variant (W2 S5) | `top` offset = header height (`h-11` / 44); bar `py-space-2` min when sticky |
| Applied-chip row | `gap-space-2`, chip `px-space-2 py-space-1`, type `text-xs` |
| Clear control | min touch **24×24** (AA); prefer `min-h-space-8` / 44 on mobile chrome |

### 5.4 Comfortable vs compact (preview — full density tokens = P1)

| Mode | Row / control height step | Type floor | Gutter |
|------|---------------------------|------------|--------|
| Comfortable (default) | 40px rows / 36–40 controls | `text-sm` body, `text-xs` meta | `--space-4`+ |
| Compact | −4 or −8px heights | still ≥ `text-xs` | **increase** outer gutters one step (Material equilibrium) |

---

## 6. Migration notes — Wave 4 `w4-spacing-tokens`

**Owns:** implement this spec in product CSS + layout shells + lint.  
**Does not own:** color/status ladder, Traces band collapse, cmdk (other W3/W4 agents).

### Phase A — Tokens (no visual churn required)

1. Add `--space-1`, `--space-5`…`--space-8` to `:root` (keep 2/3/4 values).  
2. Add `--font-size-xs: 0.75rem`.  
3. Map spacing + full type ladder in `@theme inline`.  
4. Align `body { line-height }` to `--line-height-normal` (1.5).

### Phase B — Shell rhythm

1. `PageContent` → space-* utilities (§5.1).  
2. `ResourcePageShell` → `gap-space-4` (equiv. keep).  
3. `FilterBar` → document token classes; add sticky + chip row in filter OS workstream.

### Phase C — Kill arbitrary micro-type (by hotspot score)

Migrate in order from [`w1-density-grep.md`](./w1-density-grep.md) P0 list:

1. `TranscriptView.tsx`  
2. `guardrails/page.tsx`  
3. `ApprovalCard.tsx`  
4. `alerts/page.tsx`  
5. `studio/page.tsx`  
6. `replay`, `fleet`, `observability/query`, `time-travel`, `portal-chrome`

**Replacement matrix:**

| From | To (default) | To (meta/mono only) |
|------|--------------|---------------------|
| `text-[9px]` | `text-xs` | `text-3xs` |
| `text-[10px]` | `text-xs` | `text-2xs` |
| `text-[11px]` | `text-xs` | — |
| `py-0.5` / `gap-0.5` | `py-space-1` / `gap-space-1` | — |
| `p-1` (4px) | `p-space-1` | — |

### Phase D — Lint + CI

Enable rules in §7; fail PRs that add new banned patterns outside allowlisted paths (e.g. marketing mocks).

### Explicit non-goals for `w4-spacing-tokens`

- Do not restyle accent / terminal / bg ladder.  
- Do not invent `--space-0.5` for 2px.  
- Do not use compact density as an excuse to keep `text-[10px]` on hub chrome.

---

## 7. Lint rules to add

### 7.1 ESLint (`eslint-plugin-better-tailwindcss` or custom `no-restricted-syntax` / `no-restricted-classnames`)

| Rule ID | Forbid | Allow |
|---------|--------|-------|
| `eden/no-arbitrary-micro-text` | `text-[9px]`, `text-[10px]`, `text-[11px]`, `text-[0.5625rem]`, `text-[0.625rem]` | `text-3xs`, `text-2xs`, `text-xs`+ |
| `eden/no-off-grid-half` | `py-0.5`, `px-0.5`, `gap-0.5`, `m-0.5`, `p-0.5` in `clients/portal/src` | `*-space-1` or `*-1` (4px) |
| `eden/prefer-type-tokens` | warn on `text-[Npx]` any N | named `text-*` scale |

**Severity:** `error` for micro-text + `*-0.5`; `warn` for other arbitrary `text-[…]` during Phase C.

### 7.2 Stylelint / CSS (optional)

| Rule | Forbid |
|------|--------|
| `declaration-property-value-disallowed-list` | `font-size: 9px\|10px\|11px` in product CSS |
| Custom | New `:root` spacing must be multiples of `0.25rem` |

### 7.3 CI grep gate (cheap until ESLint lands)

```bash
# fail if new hits outside allowlist
rg -n 'text-\[(9|10|11)px\]' clients/portal/src --glob '!**/*.{test,spec}.*'
rg -n '(py|px|gap|p|m)-0\.5\b' clients/portal/src --glob '!**/*.{test,spec}.*'
```

Baseline counts (2026-07-20): 376 micro-text · 165 `*-0.5` family — ratchet down per PR; block increases.

### 7.4 PR checklist (Wave 4+)

- [ ] New spacing uses `--space-1`…`8` or on-grid TW (`1`/`2`/`3`/`4`/`6`/`8`…).  
- [ ] No new `text-[9|10|11px]`.  
- [ ] Compact mode does not go below `text-xs` for readable UI.  
- [ ] Dark-terminal color tokens untouched unless a color-token ticket.

---

## 8. Acceptance criteria (for Design Brief / Wave 4)

1. `:root` defines `--space-1` through `--space-8` with values in §2.  
2. `@theme` exposes spacing + full type ladder including `--font-size-xs`.  
3. `PageContent` / `ResourcePageShell` / `FilterBar` document tokenized rhythm per §5.  
4. Ban list in §3.3 enforced by lint or CI grep.  
5. Brand tokens (bg / text / accent / terminal / radius / shadow) unchanged by this workstream.

---

## Summary scale (quick ref)

```
space-1  4px   0.25rem
space-2  8px   0.5rem   (existing)
space-3 12px   0.75rem  (existing)
space-4 16px   1rem     (existing)
space-5 24px   1.5rem
space-6 32px   2rem
space-7 40px   2.5rem
space-8 48px   3rem

type floor (comfortable UI): 12px = --font-size-xs / text-xs
meta only: 10px = 2xs · mock only: 9px = 3xs
banned: text-[9|10|11px], py/gap-0.5 as density hacks
```

---

*End of Wave 3 spacing & type token spec. Implementation: Wave 4 agent `w4-spacing-tokens`.*
