# Wave 14 — Portal INTERACTION POLISH Evidence

**Agent wave:** `w14-interaction` (jobs 1–10)  
**Date:** 2026-07-20  
**Repo:** `/Users/kaiavnihalani/Downloads/Eden`  
**Binding:** [`w3-a11y.md`](./w3-a11y.md) · [`w4-anti-clutter-contract.md`](./w4-anti-clutter-contract.md) · [`.impeccable.md`](../../../../.impeccable.md)  
**Prior:** [`w13-visual-evidence.md`](./w13-visual-evidence.md)  
**Scope:** Interaction polish only. No Waves 15–16. No marketing/docs. Core nav stays ≤12.

---

## 0. Ship verdict

| Gate | Result |
|---|---|
| Focused vitest (`w14-interaction` + ViewsMenu) | **PASS** (12 + 4) |
| `polish:check` | **PASS** |
| Half-step ratchet | **112 / 112** (was 121/121; −9 from guardrails chips) |
| Micro-text ratchet | **91 / 91** (unchanged) |

### Overall: **PASS (interaction polish landed; residual owned for W15 harden)**

---

## 1. Job roll-up (10)

| # | Job | Result | Notes |
|---:|---|---|---|
| 1 | `w14-focus-rings` | **PASS** | `FOCUS_RING_CLASS` on FilterBar selects/search/clear/chips; Dialog + Sheet close; ViewsMenu trigger/items. Button/Tabs already wired. |
| 2 | `w14-keyboard-hubs` | **PASS** | ViewsMenu Escape + outside-click close; Enter on Save-as; `aria-controls` / `role="menu"`. Mobile More via Sheet (Radix Esc + focus trap). Hub tabs remain Radix `ui/tabs`. |
| 3 | `w14-empty-microcopy` | **PASS** | Shared `U20_EMPTY_COPY` + new `U20_FILTER_EMPTY_COPY`; wired on Improve queue, Agents, Issues filter, Traces filter, Online scoring. Calm / no `!`. |
| 4 | `w14-error-retry` | **PASS** | `ErrorState` gains `onRetry` → default ≥44px Try again; `QueryState` uses `onRetry`; online-scoring uses `onRetry`. |
| 5 | `w14-touch-targets` | **PASS** | Filter Clear no longer shrinks to 24px on `sm`; applied chips are `min-h-11` removable buttons; guardrails chips `py-0.5`→`py-1`; enable toggle `min-h-11`. |
| 6 | `w14-cmdk` | **PASS** | `SETTINGS_TAB_COMMANDS` (19 tabs → `/settings?tab=`) in `buildNavCommands` — **S-06 WAIVE lifted**. Advanced sidebar routes already walked. Online scoring in `PALETTE_ACTIONS`. |
| 7 | `w14-online-scoring` | **PASS** | Improve `PATH_LINKS` Go-to + leaf back-link to `/improve` + ⌘K action. **Not** added to core nav (still ≤12). **I-02** closed without hub tab inflation. |
| 8 | `w14-dialog-sheet` | **PASS** | Dialog/Sheet close ≥44px + focus ring; Radix Dialog focus trap retained. |
| 9 | `w14-interaction-tests` | **PASS** | `src/lib/__tests__/w14-interaction.test.ts`; ViewsMenu Escape unit test; polish:check. |
| 10 | `w14-interaction-evidence` | **PASS** | This document. |

---

## 2. Files touched (summary)

| Area | Files |
|---|---|
| Focus / dialogs | `components/ui/{filter-bar,dialog,sheet,error-state,query-state}.tsx` |
| Keyboard menus | `components/portal-os/{ViewsMenu,QueryFilterBar,MobileBottomNav}.tsx` |
| CmdK / IA | `lib/nav-commands.ts` (`SETTINGS_TAB_COMMANDS`, online-scoring action) |
| Empty copy | `lib/portal-polish.ts`; hubs: `improve`, `agents`, `issues`, `traces`, `online-scoring` |
| Online scoring | `improve/page.tsx` PATH_LINKS; `improve/online-scoring/page.tsx` back-link |
| Touch | `guardrails/page.tsx` chips + toggle; FilterBar chips |
| Locks | `lib/__tests__/w14-interaction.test.ts`; ViewsMenu test; `scripts/lint-portal-classes.cjs` half-step **121→112** |

---

## 3. Test / polish evidence

### 3.1 Focused vitest

```bash
cd clients/portal
npx vitest run \
  src/lib/__tests__/w14-interaction.test.ts \
  src/components/portal-os/__tests__/ViewsMenu.test.tsx
```

→ **16 passed**.

### 3.2 `polish:check`

```bash
npm run polish:check
```

```
lint:portal-classes micro-text OK (91/91)
lint:portal-classes half-step OK (112/112)
lint:portal-classes accent-cta OK (6/6)
lint:portal-clutter OK
✓ all polish invariants pass
```

---

## 4. Peer WAIVE updates (W10 carry)

| Peer | Was | Now |
|---|---|---|
| **S-06** ⌘K → `/settings?tab=` | WAIVE | **PASS** (`SETTINGS_TAB_COMMANDS`) |
| **I-02** Online scoring discoverable | WAIVE / orphan | **PASS** (Improve Go-to + ⌘K + back-link; not core nav) |

---

## 5. Remaining for W15 harden

| Residual | Owner | Notes |
|---|---|---|
| Live `audit:a11y` / axe on hubs | QA | Needs portal on `:3000` (W10–W13 WAIVE carry) |
| Industry AC-05/08/09 stopwatch | QA | Painted nest / scan timing still WAIVE |
| Peer D-03, F-06, E-04, E-08 | Per surface | Interaction gaps beyond this wave |
| `Button sm` (32px) on dense secondary | Foundation | Primary path is `min-h-11`; keep `sm` out of mobile chrome |
| TranscriptView nested-interactive residual | Observe | Sibling pattern exists; full axe re-audit when live |
| DataTable checkbox hit area | portal-os | Still compact; extend padding if W15 a11y fails |
| Improve plans empty copy still long | Improve | Optional tighten to `U20_EMPTY_COPY` style |
| Settings rail soft-launch tabs (roles/sso) | Settings | Intentionally omitted from ⌘K |

---

## 6. Do-not list (honored)

- Did **not** start Waves 15–16  
- Did **not** touch marketing/docs  
- Did **not** expand core nav beyond 12  
- Did **not** add Online scoring as an Improve hub tab (overflow + ⌘K only)
