<!-- Wave 1 + Wave 2 refresh (`w2-token-audit`). -->

# Token Audit — `clients/portal/src/app/globals.css` (Wave 2 refresh)

**Scope:** `:root` + `@theme inline` + usage across `clients/portal/src`.  
**Date:** 2026-07-20 (Wave 2 systems discovery)  
**Plan agent:** `w2-token-audit`

> **Wave 1 stale claim corrected:** W1 said only `--space-2/3/4`. Live CSS already defines **`--space-1`…`--space-8`** and bridges them in `@theme` as `--spacing-space-*` (enables `p-space-*` / `gap-space-*`). Gap is **adoption**, not definition.

---

## 1. Spacing ladder (live)

| Token | rem | px |
|---|---:|---:|
| `--space-1` | 0.25 | 4 |
| `--space-2` | 0.5 | 8 |
| `--space-3` | 0.75 | 12 |
| `--space-4` | 1 | 16 |
| `--space-5` | 1.5 | 24 |
| `--space-6` | 2 | 32 |
| `--space-7` | 2.5 | 40 |
| `--space-8` | 3 | 48 |

**Intentionally absent:** `--space-0`, `--space-0.5` (half-step banned by density rules). Optional later: `--space-9`+ for marketing only.

**`@theme` bridge:** `--spacing-space-1`…`8` → Tailwind spacing utilities (`px-space-4`, `gap-space-3`, …).

---

## 2. Adoption skew (critical)

| Signal | Live finding |
|---|---|
| `var(--space-*)` outside `globals.css` | **~0** product files |
| `*-space-*` utilities | **~9 files** — concentrated in portal-os + layout (`PageContent`, `ResourcePageShell`, `QueryFilterBar`, `DetailPanelShell`, `ResourceOsToolbar`, `filter-bar.tsx`) |
| Raw Tailwind packing | Dominates pages: `gap-2`, `px-3`, `py-2`, `gap-1`, `p-4`, … |
| Type tokens `text-2xs` / `text-3xs` | Tokens exist; class hits **~2** — pages still use arbitrary `text-[Npx]` |
| Micro arbitrary px (`text-[9\|10\|11px]`) | **~369–371** (ratchet baseline 375 in `lint-portal-classes.cjs`) |
| Half-step `*-0.5` | **~177–301** depending on pattern family (ratchet baseline 179 for narrow half-step set) |

**Breathing-room gap for Wave 5:** migrate hub/overview chrome from raw `p-4`/`gap-2` to `--space-*` utilities; keep instrument density via `2xs/3xs` tokens instead of arbitrary px.

---

## 3. Color / type / motion (unchanged shape)

- Semantic colors: accent, terminal, success/warning/error/info, charts, stages — largely complete.
- Type: `--font-size-3xs`…`4xl` + line-heights + letter-spacing.
- Radii `--radius-sm`…`xl`; shadows `--shadow-xs`…`xl`; z-index cookie/toast/grain; motion duration/ease.
- Density is attribute-only (`data-density`), no `--density-*` CSS vars.

---

## 4. Unused / allowlist notes

- **~12 unused `:root` tokens** (no `var()` / not `@theme` LHS): `--background`, `--foreground`, `--surface`, `--surface-elevated`, `--cat-*` set, `--info-bg`, some letter-spacing aliases.
- Hex outside allowlist: `polish-check.sh` clean (allowlist: globals, clerk-theme, analytics-tab, BrowserReplayPanel).
- Hex in `.tsx` overall: ~5.

---

## 5. Wave 5 implications

1. Enforce `*-space-*` on PageContent/hub chrome (lint ratchet optional).
2. Ban new arbitrary micro-px on shell/hub chrome; migrate to `text-2xs`/`3xs`.
3. Do **not** invent `--space-0.5` — force half-step purge instead.
4. Document unused compat aliases or remove in polish pass.
