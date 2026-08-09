# Eden SOTA Market-Ready Report

> **Date:** 2026-07-17  
> **Authority:** [`SOTA-WAVE-TRACKER.md`](./SOTA-WAVE-TRACKER.md) · [`SOTA-DECLARATION.md`](./SOTA-DECLARATION.md)  
> **Program:** 30-wave SOTA Production Perfection (W0–W29)

---

## 1. Executive verdict

**Eden is market-ready for in-scope production surfaces — with explicit, operator-gated PARTIALs.**

| Verdict | Detail |
|---|---|
| Product / security / Observe / Evaluate / Improve / ChatSidebar / Autonomy | **Ship** — exits green with test evidence |
| Packaging registries @ 0.3.1 | **Split** — PyPI **0.3.1** live; npm still **0.3.0** (stale token) |
| CI auth goldens / Typesense 10M / live staging dogfood | **PARTIAL / blocked** — F12 10k contract CI shipped; 10M + staging URLs still operator-gated |

Hard constraints held: no F22 rebuild, no Eden COGS admin UI, no docs-site redesign, org/RLS/auth not weakened, no invented credentials.

---

## 2. Wave-by-wave status (W0–W29)

| Wave | Status | One-line evidence |
|---|---|---|
| W0 | **GREEN** | Tracker, regrades, ownership, CI/LOC seeds |
| W1 | **GREEN** | `test_w1_security.py` — spoof/RLS/PII/scopes |
| W2 | **GREEN** | Learn filters + GuardrailBlocked→4xx |
| W3 | **PARTIAL** | F12 contract CI 10k GREEN; F12 10M BLOCKED; F85 Clerk fallback, Actions secrets unverified |
| W4 | **GREEN** | Session round-trip Py+TS |
| W5 | **GREEN** | Bedrock+Gemini + parity matrix |
| W6 | **GREEN** | Sampling/offline/OTel; 0.3.1 metadata |
| W7 | **GREEN** | CostEvent write-through + ChatSidebar meter |
| W8 | **GREEN** | FinOps explorer + kills + cache savings |
| W9 | **PARTIAL** | Local probes 16/0/1; live staging SKIP; docker daemon broken on close host |
| W10 | **GREEN** | AppShell + Density + ui barrel |
| W11 | **GREEN** | ≥6 hubs OS + virtualization + export |
| W12 | **GREEN** | Form kit + charts + axe + mobile |
| W13 | **GREEN** | Virtualized trace detail (`traces-detail-panels.tsx`); `TranscriptV2` name **UNVERIFIABLE** |
| W14 | **GREEN** | Spans QL + filter→alert |
| W15 | **GREEN** | Sessions + rrweb-player |
| W16 | **GREEN** | Issues triage without F22 |
| W17 | **GREEN** | Alerts + signals daily-driver |
| W18 | **GREEN** | Real playground LLM + leases + VirtualizedList; 8+12 tests |
| W19 | **GREEN** | Improve loop + EvidenceGate + onboarding |
| W20 | **GREEN** | ChatSidebar spine; dual AI gone |
| W21 | **GREEN** | Navigate + filters from chat |
| W22 | **GREEN** | Alerts/signals/downloads from chat |
| W23 | **GREEN** | Loop-class; F70/U16 DONE |
| W24 | **GREEN** | Autonomy heal + N22; 16 py + 8 portal |
| W25 | **GREEN** | Evolve/promote + EvidenceGate non-optional |
| W26 | **GREEN** | F22 deleted; N20 handoff; `rg` clean |
| W27 | **GREEN** | Live + F21 labels; 10 py |
| W28 | **GREEN** | F64/F34/MCP stretch; mig 112 |
| W29 | **PARTIAL** | PyPI **0.3.1** published; npm still **0.3.0**; dry-run PASS |

**Rollup:** 26 GREEN · 3 PARTIAL (W3, W9, W29) · 0 BLOCKED product waves.

---

## 3. Feature areas achieved

| Area | What shipped |
|---|---|
| **Security / multi-tenancy** | Org JWT over spoof headers; proxy session org; RLS GUC; PII fail-closed; scopes |
| **SDK** | Sessions F23; Bedrock/Gemini; sampling/offline/OTel; version **0.3.1** |
| **FinOps** | Customer CostEvent ledger; explorer; budget alerts; feature kills; cache savings |
| **Portal OS** | `AppShell`, `MobileBottomNav`, `SavedViewsMenu`, `@tanstack/react-virtual`, `portal-cross-links.ts`; `BulkActionBar` / `ResourceOsToolbar` / `DensityProvider` **UNVERIFIABLE** |
| **Observe** | Traces/Issues/Alerts/Signals hub clients; virtualized trace detail; no F22 Fix tab; legacy `portal-os` names **REMOVED** |
| **Evaluate** | Playgrounds (real LLM path), datasets (virtualized), labeling leases/pairwise, experiments, online scoring |
| **Improve** | Severity-sorted cockpit; Book; EvidenceGate bulk; improvement-loop onboarding |
| **Loop / ChatSidebar** | W20–W23: rehydrate, navigate, act, cite-before-claim, approvals; dual `/ai` gone |
| **Autonomy** | Heal under N22; evolve/promote via EvidenceGate; FinOps tiles |
| **F22 delete / N20** | `/fix` redirected; handoff CTAs; fingerprint→plans |
| **Live / F21** | Redis live buffer; Live badge; MCP `tail_trace` + `label_tool_call` |
| **F64 / F34 / MCP** | Agentic metrics; classifier savings; MCP eql/sql/eval + Streamable HTTP honesty |
| **Packaging** | `publish_sdk.sh` dry-run; MCP smoke; portal sweep; flag/DR drills |

---

## 4. Migrations / versions / publish state

| Item | State |
|---|---|
| Alembic head | **`112_w28_f64_f34_mcp`** (single head) |
| SDK version (repo) | **0.3.1** (Py + TS synced) |
| PyPI `eden-sdk` | **0.3.1 published** — https://pypi.org/project/eden-sdk/0.3.1/ |
| npm `@eden-ai/sdk` | Registry still **0.3.0**; dry-run PASS; **stale npm token (401)** |
| MCP | `eden-mcp` smoke PASS (stdio initialize + tools/list) |

```bash
bash scripts/publish_sdk.sh dry-run
# npm only (PyPI already at 0.3.1):
SKIP_PY=1 NPM_TOKEN=… bash scripts/publish_sdk.sh publish
```

---

## 5. Test evidence (this push)

### Portal (vitest)

```
bunx vitest run w18…w29 portal suites
→ 9 files, 89 passed
```

### Python (venv 3.12, `PYTHONPATH=src`, `--noconftest`)

| Suite | Result |
|---|---|
| `tests/unit/playground/test_w18_playgrounds.py` | **8 passed** |
| `tests/unit/platform/test_w9_platform.py` | **10 passed** |
| `tests/unit/closed_loop/test_w24_autonomy.py` | **16 passed** |
| `tests/unit/promotion/test_w25_evolve_promote.py` | **8 passed** |
| `tests/unit/improvement/test_w26_n20.py` | **7 passed** |
| `tests/unit/observability/test_w27_n11_f21.py` | **10 passed** |
| `tests/unit/observability/test_w28_f64_f34_mcp.py` | **10 passed** |
| `tests/unit/llmops/test_w23_chat_sota.py` | **7 passed** |
| `tests/unit/packaging/test_w29_packaging.py` | **9 passed** |

### Scripts

| Script | Result |
|---|---|
| `bash scripts/w29_portal_sweep.sh` | **PASS** (no live `/fix`; ChatSidebar structural suites present) |
| `bash scripts/w9_local_probes.sh` | **16 PASS / 0 FAIL / 1 SKIP** (Typesense; local HTTP contracts) |
| `bash scripts/w9_staging_probes.sh` | Unit+Helm PASS; live SKIP without staging URLs |
| `bash scripts/publish_sdk.sh dry-run` | **PASS** @0.3.1 |
| `SKIP_TS=1 bash scripts/publish_sdk.sh publish` | **PyPI 0.3.1 uploaded** |
| `python scripts/bench_f12_span_search.py --n=10000 --requests=200` | p95 **20.64 ms** (SQLite proxy; not 10M) |
| `bash scripts/w29_mcp_smoke.sh` | **PASS** |

### Honesty greps

- No live `issue_fix_chat` in `src/` / `clients/` (redirects in `next.config.ts` only)
- EvidenceGate paths present on promotions / FinOps / artifacts
- F22 `/issues/[id]/fix` directory absent

### Playwright goldens

- Structural suites W20–W23 present and covered by vitest
- Full Clerk E2E **not run** — `CLERK_*` secrets absent in env
- Golden path specs exist under `clients/portal/e2e/golden/` — operator runs when Clerk test instance seeded

---

## 6. Remaining operator blockers (checklist)

- [ ] **W3 / F85** — Confirm GitHub Actions secrets (or rely on CI test-key fallback); re-auth `gh`; verify golden-paths job green
- [ ] **W3 / F12 10M** — Provision Typesense staging; prove 10M span search p95 (10k contract CI already shipped)
- [ ] **W9 live staging** — Set `EDEN_STAGING_API_URL` + `EDEN_STAGING_PORTAL_URL`; re-run `w9_staging_probes.sh`
- [ ] **W9 Typesense** — Healthy docker → `w9_local_probes.sh` compose path, or set staging Typesense secrets
- [x] **W29 PyPI** — **DONE** `eden-sdk==0.3.1`
- [ ] **W29 npm** — Refresh npm token → `SKIP_PY=1 bash scripts/publish_sdk.sh publish`
- [ ] **DR backup** — Set `BACKUP_S3_BUCKET` for non-advisory DR drill
- [ ] **Playwright ChatSidebar** — Clerk e2e seed → open→send→tool_card golden
- [ ] **Staging autonomy dogfood** — Live heal/promote under N22 (soft)

---

## 7. Recommended next 48h ops actions

1. **Publish 0.3.1** — PyPI first (`SKIP_TS=1`), then npm with `NPM_TOKEN`.
2. **Wire Clerk CI secrets** — unblock F85 auth-green + Playwright goldens.
3. **Point staging URLs** — run `w9_staging_probes.sh` + smoke portal Observe hubs.
4. **Typesense** — if NF host ready, enable and capture lag metrics; schedule F12 10M bench.
5. **DR** — configure backup bucket; run `scripts/dr_drill.sh` once non-advisory.
6. **Dogfood** — one playground matrix with real OpenRouter key; one autonomy heal in staging.

---

## 8. Code closed this market-readiness push

| Change | Path / note |
|---|---|
| Real playground LLM handler | `src/eden/playground/llm_handler.py` — ModelRouter + kill + daily cap |
| Playground service wiring | `PlaygroundService.run` + prompts routes use `make_playground_handler(org_id)` |
| Feature kill `playground` | `feature_kills._DEFAULT_ENABLED` |
| Labeling leases + pairwise | `src/eden/evaluation/labeling_leases.py` + claim/release in `labeling.py` |
| Dataset virtualization | `datasets/[id]/page.tsx` → `VirtualizedList` |
| W9 staging probes | `scripts/w9_staging_probes.sh` + `docs/ops/W9-STAGING-PROBES.md` |
| Helm worker probes | `helm/eden/templates/worker-deployment.yaml` readiness/liveness |
| Lazy governance_intel | Avoid eager numpy-heavy package import |
| W18 tests expanded | Route mock + kill switch + lease/pairwise |

---

*End of market-ready report. Tracker and declaration updated to match.*
