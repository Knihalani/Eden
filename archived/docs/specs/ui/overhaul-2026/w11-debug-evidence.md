# Wave 11 — Portal DEBUG Evidence

**Agent wave:** `w11-debug` (jobs 1–10)  
**Date:** 2026-07-20  
**Repo:** `/Users/kaiavnihalani/Downloads/Eden`  
**Binding:** [`w4-anti-clutter-contract.md`](./w4-anti-clutter-contract.md) · W10 pack [`w10-evidence-pack.md`](./w10-evidence-pack.md)  
**Scope:** Find/fix real bugs after Waves 1–10. No IA redesign. No Waves 12–16.

---

## 0. Ship verdict

| Gate | Result |
|---|---|
| Focused vitest (W5–W10 + W11 locks) | **PASS** — 11 files / **84** tests |
| `polish:check` | **PASS** |
| Live `audit:a11y` | **WAIVE** — portal not reachable on `:3000` this session |
| Anti-clutter hard caps | **HOLD** — fixes reduce embed chrome / CrossLink bands |

### Overall: **PASS (debug fixes landed; remaining owned for W12+)**

---

## 1. Job roll-up (10)

| # | Job | Result | Notes |
|---:|---|---|---|
| 1 | `w11-test-failures` | **PASS** | Baseline 75/75 green; added `w11-debug-fixes.test.ts`; updated W8 studio embed assertion |
| 2 | `w11-polish-check` | **PASS** | All invariants green before and after |
| 3 | `w11-a11y-bugs` | **PASS (static)** | FilterBar search `aria-label` + `min-h-11`; TranscriptView expand `min-h-11`; live axe WAIVE |
| 4 | `w11-query-state-bugs` | **PASS** | Improve plans: gate KPI until ready + `LoadingSkeleton`; roles/status tabs → skeleton (no blank spinner flash) |
| 5 | `w11-redirect-bugs` | **PASS** | `/optimization/model-advisor` → `/optimization?tab=advisor` (next.config + `HUB_REDIRECT_RULES`) |
| 6 | `w11-embed-chrome-leaks` | **PASS** | Fleet: hide Card KPI when embedded; Studio/Memory/Retrieval: pills tabs under embed |
| 7 | `w11-console-type` | **PARTIAL** | Touched obvious UX/runtime footguns in hub radius; billing `Partial<>` cast deferred |
| 8 | `w11-settings-form-bugs` | **PASS** | Gateway create/edit form → `FormField` + show-key `aria-label` |
| 9 | `w11-crosslink-bugs` | **PASS** | Issues / change-impact / improvement-loop / agent detail: CrossLinkBar band → More/Go to overflow |
| 10 | `w11-debug-evidence` | **PASS** | This document |

---

## 2. Bugs fixed (file list)

| Bug | Root cause | Fix | Files |
|---|---|---|---|
| Model Advisor deep-link dual chrome | Filesystem route `/optimization/model-advisor` had no 308 to Cost hub | Permanent redirect + hub rule | `next.config.ts`, `portal-hub-redirect.ts` |
| Fleet Card KPI strip under Agents | Embed still painted 5 Card KPIs (W10 residual) | `kpiStrip` only when `!embedded` | `fleet/page.tsx` |
| Studio second underline band under Evals | Nested underline TabsList read as hub chrome | Pills variant when `useEmbeddedSurface()` | `studio/page.tsx` |
| Memory/Retrieval embed tab chrome | Same nested underline band under Traces facets | Pills when embedded | `observability/memory/page.tsx`, `retrieval/page.tsx` |
| Issues CrossLinkBar band in detail | Peer chrome band vs overflow contract | DropdownMenu “Go to” in detail `headerActions` | `issues/page.tsx` |
| change-impact / onboarding CrossLinkBar toolbar | CrossLinkBar used as page toolbar band | More → Go to overflow | `improve/change-impact/page.tsx`, `onboarding/improvement-loop.tsx` |
| Agent detail CrossLinkBar peer band | CrossLinkBar under PageHeader | More → Go to in header actions | `agents/[id]/page.tsx` |
| Improve plans zero-flash KPIs | StatCards rendered while `loading && plans.length === 0` | Gate KPI + `LoadingSkeleton` | `improve/plans/page.tsx` |
| Settings roles/status blank loading | Spinner-only early return | `LoadingSkeleton` | `roles-tab.tsx`, `status-tab.tsx` |
| Gateway form a11y/FormField gap | Raw `<label>` + unlabeled show-key | `FormField` + `aria-label` | `gateway-tab.tsx` |
| FilterBar search unlabeled | Search input lacked `aria-label` / touch height | `aria-label` + `min-h-11` | `filter-bar.tsx` |
| TranscriptView expand touch | Expand control `min-h-6` | `min-h-11 min-w-11` | `TranscriptView.tsx` |

**Regression locks:** `clients/portal/src/lib/__tests__/w11-debug-fixes.test.ts`  
**Contract update:** `w8-evals-ecosystem.test.tsx` (studio embed pills).

---

## 3. Test / polish evidence

### 3.1 Focused vitest (2026-07-20)

```bash
cd clients/portal
npx vitest run \
  src/lib/__tests__/w11-debug-fixes.test.ts \
  src/app/(portal)/traces/__tests__/w6-observe-core.test.tsx \
  src/app/(portal)/__tests__/w7-satellite.test.tsx \
  src/app/(portal)/evals/__tests__/w8-evals-ecosystem.test.tsx \
  src/app/(portal)/__tests__/w9-improve-settings-advanced.test.tsx \
  src/app/(portal)/settings/__tests__/w5-settings-ia.test.ts \
  src/app/(portal)/__tests__/w6-views-os-hubs.test.ts \
  src/app/(portal)/traces/__tests__/w3-2-traces-hub.test.ts \
  src/components/ui/__tests__/w6-tables-mobile.test.ts \
  src/lib/__tests__/w10-101-a11y-interaction.test.ts \
  src/lib/__tests__/w5-b-auth-polish.test.ts
```

→ **PASS** (W11 locks + prior W5–W10 suite green in this session).

### 3.2 `polish:check`

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

### 3.3 A11y

| Check | Result |
|---|---|
| Live `npm run audit:a11y` | **WAIVE** — `:3000` not up (`curl` → 000) |
| Prior auth axe reports | Still 0 critical / 0 serious (unchanged) |
| Static W10 WAIVE follow-ups | FilterBar search label; TranscriptView expand ≥44px |

---

## 4. Remaining known bugs (Wave 12+)

| Residual | Owner | Notes |
|---|---|---|
| Users/Tools/Insights nested chrome under Analytics | Analytics | Same embed-pills pattern not yet applied |
| Alerts / Experiments detail still use CrossLinkBar | Observe / Evals | Detail CrossLinkBar is U19-OK; optional quiet variant |
| Improve `online-scoring` orphan leaf (I-02) | Improve | Not in hub PATH_LINKS |
| Billing tab `as Promise<Partial<BillingUsage>>` | Settings | Type drift bridge; not UX-broken |
| Live axe on `/agents`, `/settings`, Model Advisor hub | QA | Needs portal up |
| Golden e2e / visual smoke | QA | SKIP until `:3000` + auth seed |
| Industry AC-05/08/09 stopwatch WAIVEs | W10 → W12 | Painted nest / scan timing |
| Peer P0: D-03, F-06, E-04, E-08, S-06 | Per W10 §4.3 | Interaction gaps, not anti-clutter |

---

## 5. Do-not list (honored)

- Did **not** start Waves 12–16  
- Did **not** redesign IA or expand core nav  
- Did **not** touch marketing/docs sites  
