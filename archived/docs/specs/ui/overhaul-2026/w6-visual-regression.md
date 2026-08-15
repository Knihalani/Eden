# Wave 6 — Visual regression (chrome + key hubs)

**Agent:** `w6-visual-regression`  
**Date:** 2026-07-20  
**Scope:** Playwright / golden screenshots for portal chrome + hubs  
**Feasibility (this run):** **Could not refresh PNGs** — no portal server on `http://127.0.0.1:3000` (HTTP probe failed). Auth artifacts may exist locally (`e2e/.auth-state.json`) but capture requires a running Next app + matching Clerk session. Deliverable is **coverage map + checklist script + re-baseline commands** (additive; no evidence folders deleted).

**Related:** [`w1-test-e2e-map.md`](./w1-test-e2e-map.md) · `clients/portal/e2e/README-auth.md` · `clients/portal/e2e/golden/golden-paths.spec.mjs`

---

## 1. Current golden coverage map

### 1.1 F85 golden paths (`golden-paths.spec.mjs`)

Writes full-page PNGs to `clients/portal/e2e/golden/screenshots/{id}.png`.

| ID | Route | Key hub? | Chrome signal | Baseline PNG (present) |
|---|---|---|---|---|
| `01-sign-in-home` | `/dashboard` | **Yes** | Sidebar + AppShell + home | `01-sign-in-home.png` |
| `02-traces-hub` | `/traces` (+ fixture `?traceId=`) | **Yes** | ResourcePageShell / toolbar | `02-traces-hub.png`, `02-traces-with-fixture-id.png` |
| `03-issues` | `/issues` | **Yes** | List hub chrome | `03-issues.png` |
| `04-artifacts` | `/artifacts` | Adjacent (Improve) | Page chrome | `04-artifacts.png` |
| `05-playgrounds` | `/evals?tab=playgrounds` | No (Evaluate) | Evals hub | `05-playgrounds.png` |
| `06-alerts` | `/alerts` | **Yes** | Alerts hub | `06-alerts.png` |
| `07-experiments` | `/evals?tab=experiments` | No | Evals hub | `07-experiments.png` |
| `08-debugger-sessions` | `/debugger-sessions` | No (Advanced) | Advanced leaf | `08-debugger-sessions.png` |

**W6 key-hub scorecard (F85):**

| Hub | Covered by F85? |
|---|---|
| Dashboard | Yes (`01`) |
| Traces | Yes (`02`) |
| Issues | Yes (`03`) |
| Alerts | Yes (`06`) |
| Agents | **No** |
| Improve | **No** (artifacts only) |
| Settings | **No** |

### 1.2 Agent probes (manual / debt)

| Probe | Routes | Screenshots |
|---|---|---|
| `agent06-tour-probe.mjs` | `/dashboard?onboarding=1` → settings CTA | `agent06-tour/summary.json` only (no PNG set) |
| `agent07-portal-home-probe.mjs` | `/dashboard` @375/@1280 | `agent07-portal-home/*.png` + JSON |
| `agent08-observe-probe.mjs` | `/traces`, `/issues`, `/alerts` | Partial: `agent08-observe/375-*-auth.png` only |
| `agent09-evaluate-probe.mjs` | Evaluate surfaces | Empty `agent09-evaluate/` |
| `agent10-improve-connect-probe.mjs` | `/improve`, `/agents`, `/agents/connect`, … | Empty `agent10-improve-connect/` |

### 1.3 Other evidence (do not delete)

| Path | Notes |
|---|---|
| `screenshots/w2-07/*.png` | Fail captures from W2-07 auth/domain mismatch run |
| `screenshots/w2-traces-*-proof.png` | Live traces DOM/list proofs |
| `w2-*-*.json`, `w3-live-ingest-proof*.json`, `w2-08-live-ingest-matrix-rerun.json` | Ingest/probe stubs — leave alone |
| `w2-07-evidence/`, `w3-public-probe/`, `w10-05-final-probe/` | Historical HTTP/HTML evidence |

### 1.4 Lightweight W6 checklist (additive)

Script: `clients/portal/e2e/golden/w6-visual-smoke-checklist.mjs`

| Mode | Behavior |
|---|---|
| Default | Prints expected hubs, F85 linkage, existing vs missing PNGs (**no browser**) |
| `VISUAL_SMOKE_CAPTURE=1` | Captures additive PNGs under `screenshots/w6-visual-smoke/` |

Targets: `/dashboard`, `/traces`, `/issues`, `/alerts`, `/agents`, `/improve`, `/settings`.

---

## 2. Commands to refresh goldens

Prereqs: portal running on `BASE` (default `http://127.0.0.1:3000`), Clerk test keys in `.env.local`, Playwright installed.

### 2.1 Auth seed (local)

```bash
cd clients/portal
# portal must already be serving (npm run dev / start)
node e2e/golden/seed-auth.mjs
```

Prod / live Clerk: use `node e2e/wait-for-signin.mjs` with `BASE=https://…` and real Chrome — see `e2e/README-auth.md`.

### 2.2 Re-baseline F85 golden PNGs

```bash
cd clients/portal
GOLDEN_CI=1 node e2e/golden/golden-paths.spec.mjs
# Optional soft local report only:
# GOLDEN_ALLOW_FAIL=1 node e2e/golden/golden-paths.spec.mjs
```

Screenshots land in `e2e/golden/screenshots/{01…08}-*.png`. CI uploads the same folder as artifact `golden-screenshots-*` (`.github/workflows/portal-ci.yml`).

### 2.3 W6 hub visual smoke (inventory + capture)

```bash
cd clients/portal
# Docs-only inventory (safe offline):
node e2e/golden/w6-visual-smoke-checklist.mjs

# After seed-auth + portal up — additive captures:
VISUAL_SMOKE_CAPTURE=1 node e2e/golden/w6-visual-smoke-checklist.mjs
```

### 2.4 Optional agent probes (deeper chrome)

```bash
cd clients/portal
node e2e/golden/agent07-portal-home-probe.mjs
node e2e/golden/agent08-observe-probe.mjs
node e2e/golden/agent10-improve-connect-probe.mjs
```

### 2.5 Package script

```bash
cd clients/portal
npm run test:visual-smoke
# npm run test:visual-smoke:capture   # when env ready
```

---

## 3. Wave 5 / 6 chrome changes → which screenshots invalidate

Working-tree / overhaul edits that change **shared chrome** or **hub shells** make prior PNGs stale for visual review (assertions still “no crash,” but pixels drift).

| Change surface (examples) | Invalidates |
|---|---|
| `portal-chrome.tsx`, `sidebar-config.ts` | **All** signed-in goldens showing sidebar (`01`–`08`, agent07 desktop, any W6 smoke) |
| `AppShell.tsx`, `MobileBottomNav.tsx` | `01-sign-in-home`, agent07 mobile/desktop, agent08 mobile auth shots |
| `page-header.tsx`, `page-content.tsx` | Every hub with `PageHeader` (dashboard, issues, alerts, agents, improve, settings) |
| `ResourcePageShell`, `CoreResourcePage`, `QueryFilterBar`, `ViewsMenu`, `ResourceOsToolbar`, `DetailPanelShell` | **Traces** (`02-*`, `w2-traces-*`), Issues/Alerts if migrated to portal-os |
| Hub page rewrites (`dashboard/`, `traces/`, `issues/`, `alerts/`, `agents/`, `improve/`, `settings/`) | Matching route PNG only |
| Settings IA / rail / dual-title fixes | Future `w6-settings` smoke; tour CTA screenshots that show Settings chrome |
| Density / token / `text-[9–10px]` bans on chrome | Micro-layout drift on all chrome-heavy shots (esp. agent07 body snippets) |

**Fail PNGs** (`*-fail.png`, `w2-07/*`) are historical failure evidence — do not treat as baselines; do not delete.

**JSON stubs** (`w2-08-live-ingest-matrix-rerun.json`, `w3-live-ingest-proof-rerun.json`, etc.) are not pixel baselines — leave alone unless broken.

---

## 4. Manual verification steps (human)

When PNGs cannot be auto-refreshed, walk this checklist at **1280×800** and **375×812** after sign-in:

1. **Chrome identity** — Sidebar groups (HOME / OBSERVE / …), skip link, org switcher once, no dual Settings title smell.
2. **`/dashboard`** — One composition; first-run or telemetry; no crash toast loop.
3. **`/traces`** — ≤2 chrome bands (header + toolbar); table/empty; detail open optional.
4. **`/issues`** — List + badges; empty CTAs sane.
5. **`/alerts`** — Rules / All clear consistency; Create rule CTA when appropriate.
6. **`/agents`** — Hub loads; fleet nested via tab/redirect if applicable.
7. **`/improve`** — Board/hub loads; touch CTAs ≥44px where contracted.
8. **`/settings`** — Single identity title; rail tabs; org switch only in shell.

Compare against last known good under `e2e/golden/screenshots/` (or new `w6-visual-smoke/`). Note IA/label drift in PR description; commit refreshed PNGs only when intentionally re-baselining.

---

## 5. Recommended follow-ups (not done this wave)

1. Capture `w6-visual-smoke/*.png` once local portal + `seed-auth` succeed.
2. Optionally extend F85 `PATHS` with `09-agents`, `10-improve`, `11-settings` **after** capture proves stable (avoid CI flake without fixtures).
3. Wave 10: pixel-diff or visual hash gate — out of scope for this doc-only / checklist pass.

---

## 6. Evidence index

| Artifact | Role |
|---|---|
| This file | Coverage map + invalidation + human steps |
| `e2e/golden/w6-visual-smoke-checklist.mjs` | Offline inventory + optional capture |
| `e2e/golden/screenshots/` | Existing F85 + probe PNGs (preserved) |
| `e2e/golden/golden-paths.spec.mjs` | CI-backed 8-path runner |
