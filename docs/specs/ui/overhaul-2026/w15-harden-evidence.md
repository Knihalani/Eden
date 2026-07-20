# Wave 15 — Portal HARDEN Evidence

**Agent wave:** `w15-harden` (jobs 1–10)  
**Date:** 2026-07-20  
**Repo:** `/Users/kaiavnihalani/Downloads/Eden`  
**Binding:** [`w4-anti-clutter-contract.md`](./w4-anti-clutter-contract.md) · [`w3-a11y.md`](./w3-a11y.md) · [`w3-peer-acceptance.md`](./w3-peer-acceptance.md)  
**Prior:** [`w14-interaction-evidence.md`](./w14-interaction-evidence.md) · [`w10-evidence-pack.md`](./w10-evidence-pack.md)  
**Scope:** Harden gates only. No Wave 16 marketing/docs. Core nav stays ≤12.

---

## 0. Ship verdict

| Gate | Result |
|---|---|
| Lint ratchets (micro / half / accent / tablist) | **PASS** — **91/91 · 112/112 · 6/6 · 2/2** |
| Consolidated vitest (W5–W15 locks) | **PASS** — **17 files · 143/143** |
| `polish:check` | **PASS** |
| Golden e2e | **SKIP** — no portal on `:3000` |
| Live `audit:a11y` | **WAIVE** — no `:3000`; prior W10 auth reports 0 critical/serious |

### Overall: **PASS (portal polish waves 11–15 complete; ops/live QA WAIVEs remain)**

---

## 1. Job roll-up (10)

| # | Job | Result | Notes |
|---:|---|---|---|
| 1 | `w15-lint-ratchet` | **PASS** | Locked post-W14 floors; **tablist-outside 3→2** |
| 2 | `w15-peer-waive-closure` | **PASS + 2 WAIVE** | Closed **E-04 · E-08** (cheap); **S-06 · I-02** already PASS (W14). **D-03 · F-06** remain WAIVE (product scope) |
| 3 | `w15-button-sm-touch` | **PASS** | `Button` `sm` → `min-h-11 h-11` (was `h-8`) |
| 4 | `w15-datatable-checkbox` | **PASS** | Selection cells use `min-h-11 min-w-11` labels |
| 5 | `w15-regression-suite` | **PASS** | 143 tests; fixed stale CrossLinkBar asserts in w7/w8 |
| 6 | `w15-polish-check` | **PASS** | Full `npm run polish:check` green |
| 7 | `w15-golden` | **SKIP** | `:3000` down — re-run `test:visual-smoke` when up |
| 8 | `w15-live-a11y` | **WAIVE** | Carry W10–W14; prior `report-a11y-auth-*.json` clean |
| 9 | `w15-acceptance-update` | **PASS** | W10 pack + this doc; S-06/I-02/E-04/E-08 marked PASS |
| 10 | `w15-harden-evidence` | **PASS** | This document + README note |

---

## 2. Ratchet numbers

| Gate | Before (W14 evidence) | After (W15) |
|---|---|---|
| micro-text | 91 / 91 | **91 / 91** |
| half-step | 112 / 112 | **112 / 112** |
| accent-cta | 6 / 6 | **6 / 6** |
| tablist-outside | 2 / 3 | **2 / 2** |

Scripts: `clients/portal/scripts/lint-portal-classes.cjs`, `lint-portal-clutter.cjs`.

---

## 3. Peer WAIVE disposition

| ID | Disposition | Why / evidence |
|---|---|---|
| **S-06** | **PASS** (W14) | `SETTINGS_TAB_COMMANDS` → `/settings?tab=` |
| **I-02** | **PASS** (W14) | Improve PATH_LINKS + ⌘K Online scoring (not core nav) |
| **E-04** | **PASS** (W15) | Playground `createAndBindDataset` stays on tab; Upload/manage → Datasets |
| **E-08** | **PASS** (W15) | `buildPageContext` adds `dataset_id` / `playground_id` / `experiment_id` (+ filters/`tab`) |
| **D-03** | **WAIVE** | Fit-to-height tiles need `useFitRowCount`-class product work · Owner: Dashboard |
| **F-06** | **WAIVE** | Traces has no dedicated time control to hoist into `PageHeader` without inventing Observe time UX · Owner: Observe |

---

## 4. Code / test changes (summary)

| Area | Files |
|---|---|
| Touch | `components/ui/button.tsx`, `data-table.tsx` |
| Peer | `ai-insights/types.ts`, `playgrounds/page.tsx` |
| Lint | `lint-portal-classes.cjs`, `lint-portal-clutter.cjs` |
| Locks | `lib/__tests__/w15-harden.test.ts`; w7/w8 CrossLink → Go-to asserts |
| Docs | This file · `w10-evidence-pack.md` §4.3 · README waves 11–15 |

---

## 5. Suite / polish evidence

### 5.1 Consolidated vitest

```bash
cd clients/portal
npx vitest run \
  src/lib/__tests__/w15-harden.test.ts \
  src/lib/__tests__/w14-interaction.test.ts \
  src/lib/__tests__/w13-visual.test.ts \
  src/lib/__tests__/w12-perf.test.ts \
  src/lib/__tests__/w11-debug-fixes.test.ts \
  src/lib/__tests__/w10-101-a11y-interaction.test.ts \
  src/lib/__tests__/w10-3-nav-dead-links.test.ts \
  src/lib/__tests__/w10-w12-portal.test.ts \
  src/lib/__tests__/w5-b-auth-polish.test.ts \
  src/lib/__tests__/w6-a11y-motion.test.ts \
  'src/app/(portal)/__tests__/w6-views-os-hubs.test.ts' \
  'src/app/(portal)/__tests__/w7-satellite.test.tsx' \
  'src/app/(portal)/evals/__tests__/w8-evals-ecosystem.test.tsx' \
  'src/app/(portal)/__tests__/w9-improve-settings-advanced.test.tsx' \
  'src/app/(portal)/settings/__tests__/w5-settings-ia.test.ts' \
  'src/app/(portal)/traces/__tests__/w6-observe-core.test.tsx' \
  src/components/ui/__tests__/w6-tables-mobile.test.ts
```

→ **Test Files 17 passed · Tests 143 passed**.

### 5.2 `polish:check`

```
lint:portal-classes micro-text OK (91/91)
lint:portal-classes half-step OK (112/112)
lint:portal-classes accent-cta OK (6/6)
lint:portal-clutter tablist-outside OK (2/2)
✓ all polish invariants pass
```

### 5.3 Live ops (when `:3000` up)

```bash
npm run audit:a11y
npm run test:visual-smoke
# optional capture: npm run test:visual-smoke:capture
```

---

## 6. Remaining open WAIVEs (ops / live QA)

| Residual | Owner | Notes |
|---|---|---|
| Live `audit:a11y` (incl. `/agents`, `/settings`) | QA | Needs portal on `:3000` |
| Golden visual smoke / PNG refresh | QA | `e2e/golden/w6-visual-smoke-checklist.mjs` |
| Industry AC-05 / AC-08 / AC-09 stopwatch | QA | Painted nest + scan timing |
| Peer **D-03** fit-to-height tiles | Dashboard | Product measure API |
| Peer **F-06** Observe time in PageHeader | Observe | Needs dedicated time control design |
| Settings rail hand-rolled `role="tablist"` | Settings | Counted in tablist ratchet (1 of 2); migration optional |
| Marketing `InstallSection` tablist | Marketing | Outside portal product; Wave 16 territory |

---

## 7. Do-not list (honored)

- Did **not** start Wave 16 marketing/docs  
- Did **not** expand core nav  
- Did **not** invent `useFitRowCount` or Traces time-range product features for peer WAIVEs  

*End of Wave 15 harden evidence.*
