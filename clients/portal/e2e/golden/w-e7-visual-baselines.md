# Evaluate V3 — Wave E7 visual baselines

**Date:** 2026-07-21 · Freeze: Evaluate V3 (E0–E7)  
**Authority:** [`.research-evals-v3.md`](../../.research-evals-v3.md) · peer captures `.cursor/visual-research/evals-v3/`

## Capture status (this freeze)

| Mode | Status | Notes |
|------|--------|-------|
| Live Playwright goldens (datasets / playground / compare) | ⚠️ **deferred** | Portal `:3000` reachable, but Clerk session refresh loop (`keys do not match` / stale `e2e/.auth-state.json`) blocked authenticated product chrome. agent09 `page.goto(/evals)` timed out; `audit:a11y` could not complete product `/evals`. |
| Path contract + prior W12 goldens | ✅ | Use existing PNGs + peer law below |
| Peer grammar (E0) | ✅ | `.cursor/visual-research/evals-v3/` |

## Eden golden PNG paths (path contract)

| Surface | Route | Baseline PNG | Notes |
|---------|-------|--------------|-------|
| Playgrounds | `/evals?tab=playgrounds` | `e2e/golden/screenshots/05-playgrounds.png` (+ optional `-fail.png`) | W12 golden; V3 matrix/Run hierarchy — refresh when auth healthy |
| Experiments compare | `/evals?tab=experiments` | `e2e/golden/screenshots/07-experiments.png` (+ optional `-fail.png`) | W12 golden; V3 baseline/Diff/grades — refresh when auth healthy |
| Datasets | `/evals?tab=datasets` | *(no dedicated W12 slot)* | Deferred capture target: `e2e/golden/screenshots/agent09-evaluate/` or new `09-datasets.png` |
| agent09 evaluate probe | `/evals` + compare hop | `e2e/golden/screenshots/agent09-evaluate/{desktop-1280,mobile-375}.png` | Directory exists; **empty this freeze** (live hop failed) |

## Peer law (E0 corpus)

Root: `.cursor/visual-research/evals-v3/` · notes in folder `*-notes.md` / `OBSERVATIONS.md` if present.

| Peer | Use when reviewing |
|------|--------------------|
| Braintrust compare / playground / interpret docs scrolls | Baseline + Diff + grades grammar |
| Langfuse datasets / experiments / score analytics | Start experiment + closed loop |
| Phoenix datasets / experiments | Spreadsheet curate density |
| Promptfoo web UI / LangSmith annotation | Matrix scan + labeling queue |

## How to refresh (when Clerk auth healthy)

```bash
cd clients/portal
bun run dev   # :3000
# Re-seed if Clerk keys rotated:
# node e2e/seed-auth.mjs   # or wait-for-signin.mjs — see e2e/README-auth.md

BASE_URL=http://127.0.0.1:3000 node e2e/golden/agent09-evaluate-probe.mjs
# Writes e2e/golden/screenshots/agent09-evaluate/

PORT=3000 bun run audit:a11y
# Expect report-a11y-auth-%2Fevals.json url = product /evals (not sign-in)
```

**Do not invent pixels.** Keep prior `05-playgrounds` / `07-experiments` until live capture succeeds.

## Related

- W12 baselines: [`w12-visual-baselines.md`](./w12-visual-baselines.md)
- Route matrix: [`../../.wave-e7-route-matrix.md`](../../.wave-e7-route-matrix.md)
- Final critic: [`../../.wave-e7-final-critic.md`](../../.wave-e7-final-critic.md)
