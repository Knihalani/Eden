# Wave 12 — Visual regression baselines (V2)

Canonical PNG roots for portal UX freeze + peer grammar path contract.

## Eden golden baselines

| ID | Route | Baseline PNG | Peer grammar check |
|----|-------|--------------|--------------------|
| `01-sign-in-home` | `/dashboard` | `e2e/golden/screenshots/01-sign-in-home.png` | vs Helicone product cards — Home stays status→diagnosis→CTA, not card collage. **W8 states:** first-run (`data-home-shell-state=first-run`) ≠ period-empty failures ≠ QueryState error / NoOrg |
| `02-traces-hub` | `/traces` | `e2e/golden/screenshots/02-traces-hub.png` | vs Laminar / Braintrust — ≤8 first-paint controls; dense table |
| `03-issues` | `/issues` | `e2e/golden/screenshots/03-issues.png` | vs Langfuse master–detail |
| `04-artifacts` | `/artifacts` | `e2e/golden/screenshots/04-artifacts.png` | Improve loop calm list |
| `05-playgrounds` | `/playgrounds` | `e2e/golden/screenshots/05-playgrounds.png` | Evaluate primary surface |
| `06-alerts` | `/alerts` | `e2e/golden/screenshots/06-alerts.png` | Feed + severity strip |
| `07-experiments` | `/evals?tab=experiments` | `e2e/golden/screenshots/07-experiments.png` | Compare |
| `08-debugger-sessions` | `/debugger-sessions` | `e2e/golden/screenshots/08-debugger-sessions.png` | Advanced calm list |

## Peer corpus (Wave 0 / 0b)

Root: `.cursor/visual-research/ai-portals/` · Synthesis: `.cursor/visual-research/ai-portals-wave0b/OBSERVATIONS.md`

| Peer ref (path contract) | Use when reviewing |
|--------------------------|--------------------|
| `lmnr-home-scroll1.png` / `lmnr-home-scroll2.png` | Transcript density, meta on row |
| `langfuse-public-trace-scroll0.png` | Split inspector, Annotate CTAs |
| `braintrust-observe-scroll0.png` | Filter · Display · Search toolbar |
| `helicone-home-product-scroll0.png` | What Home must *not* become for traces |
| `arize-phoenix-product-scroll0.png` | Annotate → experiment scent |

Locked in code: `WAVE12_PEER_VISUAL_REFS` in `src/lib/portal-polish.ts`.

## How to refresh

```bash
# Checklist only (no browser)
bun run test:visual-smoke

# Capture (portal + Clerk auth required)
bun run test:visual-smoke:capture

# Full 8 golden paths
node e2e/golden/golden-paths.spec.mjs
```

Auth: `e2e/.auth-state.json` — see `e2e/README-auth.md`.

## Home state baselines (Wave 8 / Home + Shell fleet)

| State | Marker | Capture notes |
|-------|--------|---------------|
| First-run / listening | `[data-home-shell-state="first-run"]` · `[data-testid="dashboard-first-run"]` | Org with zero traces; pulse + doctor next step |
| Ready (empty failures window) | `[data-home-shell-state="empty"]` · `data-empty-kind` | Has traffic, no failures in range — not first-run |
| Error | `[data-query-state="error"]` | Telemetry shard failure banner / failures unavailable |
| NoOrg | `[data-home-shell-state="no-org"]` | Signed in, no workspace |
| Loading | `[data-home-shell-state="loading"]` | Route `loading.tsx` / org sync skeleton |

**Manual refresh (when live capture blocked):**

```bash
# Portal running + e2e/.auth-state.json present
node e2e/golden/agent07-portal-home-probe.mjs
# Writes e2e/golden/screenshots/agent07-portal-home/{desktop-1280,mobile-375}.png

# Or full golden path 01
node e2e/golden/golden-paths.spec.mjs
# Updates e2e/golden/screenshots/01-sign-in-home.png
```

If auth/session expires, keep prior PNGs and document `-fail.png` pair; do not invent pixels. See `.home-shell-w8-states.md`.

## Improve V3 group (Wave 11 freeze)

Path-contract baselines for Improve-group routes. Golden PNG where listed; otherwise marker + axe report = visual signoff until live capture.

| ID | Route | Baseline / evidence | Peer / IA check |
|----|-------|---------------------|-----------------|
| `improve-queue-v3` | `/improve` | walkthrough + axe `report-a11y-auth-%2Fimprove.json` · markers `data-wave2-improve-queue` … `data-wave10-improve-verify` | Master–detail; ViewsMenu; related strip Issues · Artifacts · Ledger · Prompts |
| `04-artifacts` | `/artifacts` | `e2e/golden/screenshots/04-artifacts.png` (+ optional `-fail.png`) | Evidence-gated promote; calm list (not StatCard wall) |
| `improve-ledger-v3` | `/ledger` | axe `report-a11y-auth-%2Fledger.json` · `data-wave4-improve-ledger` | Promotions nested as Ledger mode |
| `improve-prompts-v3` | `/prompts` | axe `report-a11y-auth-%2Fprompts.json` · `data-wave5-improve-prompts` | **Core** Improve (not Advanced); lifecycle split; no Studio merge |
| `improve-guardrails-v3` | `/guardrails` | axe `report-a11y-auth-%2Fguardrails.json` · `data-wave6-improve-guardrails` | Advanced; Promptfoo report drill |
| `improve-cost-v3` | `/optimization` | axe `report-a11y-auth-%2Foptimization.json` · `data-wave7-improve-cost` | Advanced Cost KPI + Advisor |
| `improve-plans-detail-v3` | `/improve/plans/[id]` | `data-wave3-improve-plans` · Diff/Summary path contract | Braintrust Diff/Summary grammar on Eden DiffViewer |

**Do not confuse with Evaluate goldens** `05-playgrounds` / `07-experiments` — those stay Evaluate; Prompts may deep-link playground iterate without owning the surface.

Locked in freeze vitest: `w11-improve-v3-freeze.test.ts` asserts these ids are documented here and Improve-group axe reports / markers exist.

## Contract

Vitest `w12-freeze.test.ts` asserts each baseline id has a `.png` or `-fail.png` under `e2e/golden/screenshots/`, and peer ref filenames exist under the visual-research corpus (or are documented here).

**This freeze:** golden PNGs present (some paired `-fail.png` from prior live runs). Full pixel-diff CI still backlog. 75-route live screenshot sweep blocked without long-lived auth session — see `.wave12-route-matrix.md`. Improve V3 group re-signed via path contract + auth axe reports (fresh build/re-axe = soft residual).
