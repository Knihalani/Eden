# Wave 12 — Portal PERFORMANCE Evidence

**Agent wave:** `w12-perf` (jobs 1–10)  
**Date:** 2026-07-20  
**Repo:** `/Users/kaiavnihalani/Downloads/Eden`  
**Binding:** [`w4-anti-clutter-contract.md`](./w4-anti-clutter-contract.md) · [`.impeccable.md`](../../../../.impeccable.md) · Prior [`w11-debug-evidence.md`](./w11-debug-evidence.md)  
**Scope:** Make portal feel faster/lighter. No Waves 13–16. No marketing/docs. ≤2 chrome-band grammar held.

---

## 0. Ship verdict

| Gate | Result |
|---|---|
| Focused vitest (`w12-perf` + chrome / traces / W11 locks) | **PASS** — 5 files / **51** tests |
| Related `w10-w12` CrossLink lock (updated for W11 overflow) | **PASS** after lock refresh |
| `polish:check` | **PASS** |
| Live Lighthouse / bundle analyzer | **WAIVE** — cheap static + structural measure; no `:3000` session for runtime LCP |

### Overall: **PASS (perf optimizations landed; residual owned for W13+)**

---

## 1. Job roll-up (10)

| # | Job | Result | Notes |
|---:|---|---|---|
| 1 | `w12-bundle-hotspots` | **PASS** | Traces: dynamic `LiveTailPanel` / `TraceExportModal` / `AnnotateTraceDialog`. Session: dynamic `TraceDetailPanel` + `BrowserReplayPanel`. Detail: dynamic `ScoresTab` + `LatencyHistogram`. rrweb remains iframe-UMD. Analytics charts already dynamic. |
| 2 | `w12-chrome-lazy` | **PASS** | `portal-chrome` still `dynamic()` for CommandPalette / ChatSidebar / OnboardingOverlay (tour). Locked in `w12-perf` + A1 chrome tests. |
| 3 | `w12-virtualization` | **PASS** | Traces / Spans / Sessions → `InfiniteDataTable`; transcript → `VirtualizedTranscript`; Issues/Alerts/Improve → `VirtualizedList`. No regressions found. |
| 4 | `w12-loading-waterfall` | **PASS** | Fleet `loading.tsx` was re-exporting the page (eager client graph) → `LoadingSkeleton`. Status tab route skeleton added. Insights/Topics use skeleton recipes instead of spinner-only flash. Analytics overview queries already parallel via `useOrgQuery`. |
| 5 | `w12-url-state-churn` | **PASS** | `useResourceUrlState` skips `router.replace/push` when QS unchanged. |
| 6 | `w12-table-perf` | **PASS** | `TracesTab` columns `useMemo`; `DataTable` sort memo keys on `columnKeySig`; `InfiniteDataTable` avoids paging remount thrash when virtualized. |
| 7 | `w12-analytics-embed` | **PASS** | Users / Tools / Insights / Topics: hide `PageHeader` when embedded + pills nested tabs (W11 residual). Analytics only mounts active embed child. |
| 8 | `w12-image-font` | **PASS** | Root `Geist` / `Geist_Mono` set `display: "swap"`. Profile avatar already fixed 80×80 `next/image`. No second display font (K11 budget). |
| 9 | `w12-perf-tests` | **PASS** | `src/lib/__tests__/w12-perf.test.ts` + polish:check. |
| 10 | `w12-perf-evidence` | **PASS** | This document. |

---

## 2. Optimizations landed (file list)

| Change | Why | Files |
|---|---|---|
| Dynamic LiveTail / export / annotate | Keep SSE + modal graphs off traces first paint | `traces/page.tsx` |
| Dynamic session TraceDetail + BrowserReplay | rrweb/detail off session shell | `sessions/[sessionId]/page.tsx` |
| Dynamic ScoresTab / LatencyHistogram | Mode-gated detail panes | `TraceDetailPanel.tsx` |
| URL noop skip | Stop filter thrash re-renders | `useResourceUrlState.ts` |
| Memo columns + columnKeySig sort | Avoid table re-sort / header churn | `TracesTab.tsx`, `data-table.tsx`, `InfiniteDataTable.tsx` |
| Fleet / status skeletons | Kill loading waterfall leftovers | `fleet/loading.tsx`, `settings/(tabs)/status/loading.tsx` |
| Embed quiet Users/Tools/Insights/Topics | Dual chrome under Analytics | `users/page.tsx`, `tools/page.tsx`, `insights/page.tsx`, `insights/topics/page.tsx` |
| Active-tab-only analytics embeds | Avoid eager embed mount | `analytics/page.tsx` |
| Font `display: "swap"` | CLS / FOIT hygiene | `app/layout.tsx` |
| Regression locks | Hold W12 contracts | `lib/__tests__/w12-perf.test.ts`, `w10-w12-portal.test.ts` (CrossLink count) |

---

## 3. Measure notes (cheap)

| Signal | Before (code) | After |
|---|---|---|
| Traces hub static imports of LiveTail/export/annotate | Eager | `dynamic()` — load only when live/export/annotate used |
| Fleet soft-nav `loading.tsx` | Re-exported full `page` module | Skeleton only |
| Analytics nested PageHeader under hub | Always painted | Suppressed when `useEmbeddedSurface()` |
| `useResourceUrlState` identical patch | Always `router.replace` | Early return |
| Chrome islands | Already lazy (W prior) | Confirmed + re-locked |

No production Lighthouse numbers this session (portal not up on `:3000`). Prefer structural + vitest locks over speculative `useMemo` micro-opts (React Compiler / repo guidance).

---

## 4. Test / polish evidence

### 4.1 Focused vitest

```bash
cd clients/portal
npx vitest run \
  src/lib/__tests__/w12-perf.test.ts \
  src/hooks/__tests__/a1-chrome.done-when.test.ts \
  src/app/\(portal\)/traces/__tests__/w3-2-traces-hub.test.ts \
  src/lib/__tests__/w11-debug-fixes.test.ts \
  src/app/\(portal\)/__tests__/w6-views-os-hubs.test.ts
```

→ **PASS** (5 files / 51 tests)

Also: `w4-4-fleet-honest-stub` + `w8-evals-ecosystem` PASS; `w10-w12-portal` CrossLink assertion refreshed for W11 Go-to overflow.

### 4.2 `polish:check`

```
lint:portal-layout OK
lint:portal-classes micro-text OK (96/112)
lint:portal-classes half-step OK (138/139)
lint:portal-classes accent-cta OK (6/6)
lint:portal-clutter settings-org-select OK (0)
lint:portal-clutter chrome-band markers OK
lint:portal-clutter tablist-outside OK (2/3)
✓ all polish invariants pass
```

---

## 5. Remaining perf debt (W13+)

| Residual | Owner | Notes |
|---|---|---|
| Runtime LCP / INP on hubs | Perf / QA | Needs portal up + auth seed; stopwatch AC-05/08/09 still WAIVE from W10 |
| Dashboard fan-out query budget | Observe | Many parallel `useOrgQuery` — already parallel; consider priority/staleTime tuning |
| `InfiniteDataTable` selection across virtual window | Table OS | Selection is window-scoped when virtualized; bulk across full list still debt |
| Settings `analytics-tab` recharts | Settings | Tab is already `dynamic()` from settings hub; further chart split optional |
| Alerts / Experiments detail CrossLinkBar quiet variant | Observe / Evals | W11 residual; U19-OK as detail bar |
| Improve `online-scoring` orphan leaf (I-02) | Improve | Not perf-critical |
| Bundle analyzer CI artifact | Tooling | Optional `@next/bundle-analyzer` gate for hub routes |
| Golden e2e / visual smoke | QA | SKIP until `:3000` + auth |

---

## 6. Do-not list (honored)

- Did **not** start Waves 13–16  
- Did **not** touch marketing/docs  
- Did **not** break ≤2 band grammar (embed pills / header suppress reduce nested chrome)  
- Did **not** add premature micro-memo beyond table column identity / existing repo patterns  
