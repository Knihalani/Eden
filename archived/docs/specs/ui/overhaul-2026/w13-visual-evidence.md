# Wave 13 — Portal VISUAL POLISH Evidence

**Agent wave:** `w13-visual` (jobs 1–10)  
**Date:** 2026-07-20  
**Repo:** `/Users/kaiavnihalani/Downloads/Eden`  
**Binding:** [`w4-anti-clutter-contract.md`](./w4-anti-clutter-contract.md) · [`w3-density-rules.md`](./w3-density-rules.md) · [`w3-spacing-tokens.md`](./w3-spacing-tokens.md) · [`.impeccable.md`](../../../../.impeccable.md)  
**Prior:** [`w12-perf-evidence.md`](./w12-perf-evidence.md)  
**Scope:** Thorough visual polish. No Waves 14–16. No marketing/docs. Do not undensify Transcript instrument content.

---

## 0. Ship verdict

| Gate | Result |
|---|---|
| Focused vitest (`w13-visual` + W11 CrossLink lock) | **PASS** |
| `polish:check` | **PASS** |
| Micro-text ratchet | **91 / 91** (was 96/112) |
| Half-step ratchet | **121 / 121** (was 138/139) |

### Overall: **PASS (visual polish landed; residual owned for W14+)**

---

## 1. Job roll-up (10)

| # | Job | Result | Notes |
|---:|---|---|---|
| 1 | `w13-density-hotspots` | **PASS** | Users `text-[10px]` → `text-2xs`; insights/dashboard/portal-chrome/outcomes chips `py-0.5` → `py-1`; autonomous `text-[11px]` → `text-xs`. Instrument (Transcript) untouched. |
| 2 | `w13-card-nests` | **PASS** | Tools empty attribution unwrapped from Card; model-advisor Compare/Project → `Panel`; tools recommender peers → `Panel`; users recent-traces double-pad flattened (`padding="none"`). |
| 3 | `w13-alerts-experiments-crosslink` | **PASS** | Alerts + Experiments detail CrossLinkBar → `Go to` dropdown (W11 pattern). Locked in `w13-visual` + `w11-debug-fixes`. |
| 4 | `w13-spacing-rhythm` | **PASS** | Insights / users / correlation tabs → `space-y-space-*` / `gap-space-*`; PageContent/PageHeader already tokenized (re-locked). |
| 5 | `w13-type-hierarchy` | **PASS** | PageHeader title `text-xl lg:text-2xl`, eyebrow `text-2xs mono`, subtitle `text-sm`; settings exports/autonomous section titles quieted to `text-sm` (no dual H1). |
| 6 | `w13-kpi-strips` | **PASS** | Insights overview strip → 2-up `max-w-xl` (not empty 4-col wall); guardrails PII categories `.slice(0, 7)`; Home `HOME_KPI_CAP_DESKTOP = 7` re-locked; alerts severity strip already thin. |
| 7 | `w13-empty-visual` | **PASS** | Insights week empty → `EmptyState`; tools empty attribution plain `EmptyState`; ErrorState/EmptyState defaults remain quiet (`plain` / token pad). |
| 8 | `w13-settings-cards` | **PASS** | Exports destination/schedule/legacy forms → `Panel tone="inset"`; autonomous intro/tiers spacing tokens + quieter title. |
| 9 | `w13-visual-tests` | **PASS** | `src/lib/__tests__/w13-visual.test.ts` + polish:check; ratchets lowered. |
| 10 | `w13-visual-evidence` | **PASS** | This document. |

---

## 2. Files touched (summary)

| Area | Files |
|---|---|
| CrossLink quiet | `alerts/page.tsx`, `experiments/page.tsx` |
| Density / chips | `users/page.tsx`, `insights/page.tsx`, `portal-chrome.tsx`, `dashboard/_components/{latency,throughput,recent-traces}-card.tsx`, `optimization/outcomes/page.tsx`, `settings/_components/autonomous-tab.tsx` |
| Card flatten | `tools/page.tsx`, `optimization/model-advisor/page.tsx`, `settings/_components/exports-tab.tsx`, `users/page.tsx` |
| KPI / empty | `insights/page.tsx`, `guardrails/page.tsx` |
| Type / rhythm | `components/layout/page-header.tsx` |
| Locks | `lib/__tests__/w13-visual.test.ts`, `lib/__tests__/w11-debug-fixes.test.ts`, `scripts/lint-portal-classes.cjs` |

---

## 3. Ratchet evidence

```
lint:portal-classes micro-text OK (91/91)
lint:portal-classes half-step OK (121/121)
lint:portal-classes accent-cta OK (6/6)
```

Delta vs W12 evidence: micro **96→91** (−5), half-step **138→121** (−17).

---

## 4. Test / polish evidence

### 4.1 Focused vitest

```bash
cd clients/portal
npx vitest run \
  src/lib/__tests__/w13-visual.test.ts \
  src/lib/__tests__/w11-debug-fixes.test.ts
```

### 4.2 `polish:check`

```bash
npm run polish:check
```

→ layout / classes / clutter gates PASS after ratchet.

---

## 5. Remaining visual debt (W14+)

| Residual | Owner | Notes |
|---|---|---|
| Guardrails table chip `py-0.5` still common | Guardrails | Explorer/instrument-adjacent badges; tokenize remaining half-steps when touching rows |
| TraceDetail / ArtifactDetail / Session CrossLinkBar | Observe | Still valid detail bars; quiet to Go-to only if band noise returns |
| Settings tabs beyond exports/autonomous | Settings | status/security/mcp still multi-bordered sections |
| Model-advisor form `Card` + Recommendation `Card` | Optimize | Single containers OK; further Panel migration optional |
| Live painted stopwatch / band / KPI mobile | QA | Needs portal up (W10 WAIVE carry) |
| Transcript instrument micro-type | Observe | **Keep dense** — tokenize only, never undensify |
| Marketing/docs density | Out of scope | Do not touch |

---

## 6. Do-not list (honored)

- Did **not** start Waves 14–16  
- Did **not** touch marketing/docs  
- Did **not** undensify Transcript / instrument lane content  
- Did **not** add fake KPI walls (insights strip narrowed; PII cats capped)  
