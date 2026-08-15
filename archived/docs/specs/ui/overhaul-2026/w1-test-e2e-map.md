<!-- Wave 1 + Wave 2 refresh (`w2-test-e2e-map`). -->

# Portal tests + polish gates map (Wave 2 refresh)

**Date:** 2026-07-20 · Plan agent: `w2-test-e2e-map`  
Scripts: `clients/portal/package.json`. CI: `.github/workflows/portal-ci.yml` (vitest, build, bundle, a11y, golden).

---

## 1. Test inventory

| Kind | Count / path | Coverage |
|---|---|---|
| Vitest files | **95** under `clients/portal/src` | IA (U18/U19/U20), hubs, settings, polish structural |
| Golden e2e | `e2e/golden/golden-paths.spec.mjs` | **8 F85 paths** (home, traces, issues, artifacts, playgrounds via evals, alerts, experiments via evals, debugger-sessions) |
| Agent probes | `e2e/agent06`–`agent10-*-probe.mjs` | Manual/debt |
| Evidence JSON | `e2e/golden/w2-*`, `w3-*`, probes | Not band-budget tests |

Hub/query suites exist for: traces, issues, alerts, agents, improve, datasets, debugger, experiments, playgrounds, observability children, settings×3+, dashboard, artifacts, fleet, guardrails, etc.

---

## 2. Polish / layout / class / a11y gates

| Gate | Script | Enforces | Band / KPI / nest budget? |
|---|---|---|---|
| `lint:portal-layout` | `scripts/lint-portal-layout.cjs` | No `min-h-screen` / `h-screen` on portal pages | **No** |
| `lint:portal-classes` | `scripts/lint-portal-classes.cjs` | No hardcoded TW colors; **ratchet** micro ≤375, half-step ≤179, accent CTA ≤25 | **Partial** (micro/off-grid only) |
| `polish:check` | `scripts/polish-check.sh` | Hex, badge dupes, logo, mocks, dead CSS vars, overflow | **No** |
| `audit:a11y` | `scripts/audit-a11y.cjs` | axe on U20 routes | **No** clutter |

**Note:** `lint:portal-*` / `polish:check` are package scripts; confirm portal-ci wiring separately — W1 claimed local-only.

---

## 3. Coverage gaps for clutter / band-budget (Wave 2 finding)

| Missing gate | Why it matters |
|---|---|
| No Vitest for chrome **bands ≤2** on Traces/Issues/Alerts | Primary anti-clutter exit |
| No test for Home `DEFAULT_WIDGETS.length ≤ 7` or mobile KPI ≤4 | Home overwhelm |
| No e2e for Improve narrow (&lt;lg) non-5-stack | Mobile overwhelm |
| No gate for QueryState adoption % | Status thrash |
| No gate for `fallback={null}` outside overlay allowlist | Blank flash |
| No nested-Card / Card→DataTable lint | Card-nest doctrine |
| Golden paths only assert “loaded / no crash” | Not calm/scannable |

---

## 4. Blast radius (unchanged shape)

| Change | Likely first failures |
|---|---|
| Sidebar IA / Advanced | U12/U18/U19 IA suites; mobile nav tests |
| PortalChrome / AppShell | chrome a11y / density; golden home |
| Traces hub chrome | `traces/__tests__/w3-2-traces-hub.test.ts`; observe golden |
| Button/Tabs migration | polish-check; class lint accent ratchet |
| Density tokenize | micro-text ratchet (`BASELINE_MICRO_TEXT=375`) |

---

## 5. Wave 5 / 10 test plan seeds

- W5: add band-budget source asserts + `fallback={null}` allowlist test + accent CTA ratchet tighten.
- W10: clutter verifier re-scores W1 top-20; assert hubs bands ≤2; toolbar primary ≤5; card-nest ban; Home &lt;5s scan checklist.

---

## 6. Wave 6 visual regression (chrome + key hubs)

See [`w6-visual-regression.md`](./w6-visual-regression.md): F85 coverage map, agents/improve/settings gaps, re-baseline commands, chrome invalidation matrix.

```bash
cd clients/portal
npm run test:visual-smoke                 # offline inventory
# npm run test:visual-smoke:capture       # needs portal + seed-auth
```
