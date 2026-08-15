<!-- Wave 1 + Wave 2 refresh (`w2-states-loading`). -->

# Portal State / Loading UX Map (Wave 2 refresh)

Workspace: `/Users/kaiavnihalani/Downloads/Eden/clients/portal`  
**Date:** 2026-07-20 · Plan agent: `w2-states-loading`  
**Doctrine:** blank flash = confusion; QueryState preferred on async hubs.

---

## 1. State component catalog

| Component | Path | Role |
|---|---|---|
| **EmptyState** | `components/ui/empty-state.tsx` | Empty panel; sizes/variants + optional CTA |
| **ErrorState** | `components/ui/error-state.tsx` | Failure + retry; `data-eden-error-state` |
| **QueryState** | `components/ui/query-state.tsx` | `loading → error → empty → children` |
| **NoOrgState** | `components/ui/no-org-state.tsx` | Orgless / syncing gate |
| **Skeleton / LoadingSkeleton** | `components/ui/skeleton.tsx` | Route + inline shimmer |
| **PageLoading / PageLoadingSkeleton** | `layout/page-content.tsx` | Padded spinner / skeleton wrappers |
| **DataTable empty*** | `ui/data-table.tsx` | Forwards to EmptyState |

---

## 2. Adoption (live 2026-07-20)

| Component | Approx prod reach |
|---|---|
| EmptyState | **~54–56** import files; heavy on pages + DataTable |
| ErrorState | **~93** importers; **~59 / 75** portal pages |
| QueryState | **6 pages only** (up from W1’s 3) |
| LoadingSkeleton | Dominant in `loading.tsx` |

### QueryState pages (6)

1. `agents/page.tsx`
2. `alerts/page.tsx`
3. `issues/page.tsx`
4. `improve/page.tsx`
5. `audit-trail/page.tsx`
6. `settings/(tabs)/webhooks-dlq/page.tsx`

**Still hand-rolling** `if (loading)/if (error)/if empty` on most hubs (Traces, Evals, Settings tabs, Dashboard, etc.).

---

## 3. `loading.tsx` — **79 files**

| Kind | Count | Notes |
|---|---:|---|
| `LoadingSkeleton` | 70 | Dominant portal pattern |
| Auth `Loader2` spinner | 6 | auth + sign-in/up |
| Custom `Skeleton` | 2 | dashboard, settings |
| Anti-pattern | 1 | `fleet/loading.tsx` re-exports `./page` (no loading UI) |

**Portal pages missing `loading.tsx` (2):**
- `onboarding/improvement-loop/page.tsx`
- `settings/(tabs)/status/page.tsx`

---

## 4. `fallback={null}` — blank-flash risk

**Live prod sites (excl. tests): 2** (down from W1’s ~6)

| Location | Notes |
|---|---|
| `portal-chrome.tsx` | `<Suspense fallback={null}><OnboardingOverlay />` — intentional overlay; can still flash empty main |
| `observability/_components/SelectedTraceCard.tsx` | Suspense around selected-trace card |

Agents test forbids `fallback={null}` on agents pages (`w4-1-agents-pages.test.ts`). Settings hub itself uses `SettingsLoading` — **not** null.

**~24** production Suspense sites; majority use skeleton/tab loading. Guardrails still spinner-only in places.

---

## 5. Confusion / Wave 5 targets

1. Migrate async hubs (Traces, Evals, Settings lists, Dashboard) to **QueryState**.
2. Allowlist `fallback={null}` to overlays only; ban on hubs/settings content.
3. Fix `fleet/loading.tsx` anti-pattern.
4. Add missing `loading.tsx` for improvement-loop + settings/status.
5. One skeleton language (LoadingSkeleton variants) — reduce inline Loader2 thrash (~74 portal app files).
