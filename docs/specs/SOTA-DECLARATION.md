# Eden SOTA Declaration (Wave 29)

> **Date:** 2026-07-17  
> **Program:** 30-wave SOTA Production Perfection (W0–W29)  
> **Authority:** Exit-gated tracker [`SOTA-WAVE-TRACKER.md`](./SOTA-WAVE-TRACKER.md)  
> **Market-ready report:** [`SOTA-MARKET-READY-REPORT.md`](./SOTA-MARKET-READY-REPORT.md)  
> **Out of program (unchanged):** Eden COGS UI · F22 rebuild · docs-site redesign · Go/Rust GA

---

## Executive claim

**Authorized claim:** Eden is **SOTA-ready for production** on the scoped program surfaces — **with explicit PARTIALs**.

This is **not** a claim of zero remaining infra work. Soft PARTIALs below are known, tracked, and do **not** silently weaken security.

| Claim tier | Status |
|---|---|
| Security / multi-tenancy (W1) | **GREEN** — no weaken |
| Gateway correctness (W2) | **GREEN** |
| SDK sessions + instrumentations + reliability (W4–W6) | **GREEN** — PyPI **0.3.1**; npm publish **PARTIAL** |
| Customer cost ledger + FinOps (W7–W8) | **GREEN** |
| Portal shell → Observe → Evaluate → Improve (W10–W19) | **GREEN** — W18 playground LLM **GREEN** |
| ChatSidebar Loop-class copilot (W20–W23) | **GREEN** — Playwright E2E deferred (Clerk) |
| Autonomy heal / evolve / promote (W24–W25) | **GREEN** — staging dogfood soft |
| F22 deleted; N20 handoff (W26) | **GREEN** |
| Live + labels + F64/F34/MCP stretch (W27–W28) | **GREEN** |
| Platform/storage/F84 (W9) | **PARTIAL** — code + local probes PASS; live staging SKIP |
| Packaging + drills + declaration (W29) | **PARTIAL** — PyPI **0.3.1** published; npm still **0.3.0** |

**SOTA claim authorized:** **YES, with honesty** — program DoD met for in-scope product surfaces; packaging registries and CI/staging proofs remain PARTIAL as listed.

---

## Definition of Done — true vs soft

| DoD item | True? | Notes |
|---|---|---|
| W0–W2 exits green | **True** | Tracker evidence |
| W3 CI / F85 / F12 | **Soft** | F12 contract CI (10k) GREEN; F12 10M BLOCKED; F85 Clerk fallback in CI, Actions secrets unverified |
| SDK F23 + instrumentations + OTel/sampling (W4–W6) | **True** | Code + tests; version **0.3.1** |
| PyPI `eden-sdk` + npm `@eden-ai/sdk` published at exit version | **Soft** | PyPI **0.3.1** published; npm still **0.3.0** (stale token) |
| Customer cost ledger + FinOps (W7–W8) | **True** | |
| Platform/storage/F84 (W9) | **Soft** | Local probes 16 PASS / 1 SKIP; live staging URLs unset |
| Portal OS + Observe hubs (W10–W17) | **True** | No F22 investment |
| Evaluate depth (W18) | **True** | Real LLM handler + kill/cap; leases; dataset virtualization |
| Improve + onboarding (W19) | **True** | |
| ChatSidebar SOTA (W20–W23) | **True** | Structural goldens; full Playwright deferred |
| Autonomy loop + evolve/promote (W24–W25) | **True** | Staging dogfood soft |
| F22 deleted + N20 (W26) | **True** | `rg` + redirect |
| N11 live + F21 labels (W27) | **True** | Staging live p95 soft |
| F64 / F34 / MCP stretch (W28) | **True** | Streamable HTTP JSON-RPC honesty |
| `eden-mcp` installable + smoke | **True** | `scripts/w29_mcp_smoke.sh` |
| Flag + DR drills | **Soft** | Contract + workflow; DR advisory without backup bucket |
| Perf/cost scorecard vs standards | **True** | [`SOTA-PERF-COST-SCORECARD.md`](./SOTA-PERF-COST-SCORECARD.md) |
| No F22 rebuild / no Eden COGS UI / no docs redesign | **True** | Hard constraints held |
| Alembic single head | **True** | Expected head `112_w28_f64_f34_mcp` |

---

## Packaging status (W4–W6 exit close)

| Package | Version (repo) | Registry (as of close) | Dry-run | Publish |
|---|---|---|---|---|
| `eden-sdk` (PyPI) | **0.3.1** | **0.3.1** on PyPI | **PASSED** | **DONE** — https://pypi.org/project/eden-sdk/0.3.1/ |
| `@eden-ai/sdk` (npm) | **0.3.1** | **0.3.0** on npm | **PASSED** | **Blocked** — `npm whoami` 401; refresh `NPM_TOKEN` / `npm login` |

**Publish commands (operators):**

```bash
bash scripts/publish_sdk.sh dry-run
# npm side only (PyPI already at 0.3.1):
SKIP_PY=1 bash scripts/publish_sdk.sh publish
```

Guides: [`sdk/DEPLOY.md`](../../sdk/DEPLOY.md), [`sdk/python/DEPLOY.md`](../../sdk/python/DEPLOY.md), [`sdk/ts-ai/DEPLOY.md`](../../sdk/ts-ai/DEPLOY.md).

---

## Drills

| Drill | Artifact | Honesty |
|---|---|---|
| Feature flags | `/admin/flags` + Settings status; `scripts/w29_flag_dr_drills.sh` | Contract-level unless staging URL set |
| Disaster recovery | `scripts/dr_drill.sh` + `.github/workflows/dr-drill.yml` | Advisory in CI without `BACKUP_S3_BUCKET` |
| Portal F22 sweep | `scripts/w29_portal_sweep.sh` | Must stay empty of live `/fix` |
| MCP smoke | `scripts/w29_mcp_smoke.sh` | stdio initialize + tools/list |
| W9 staging probes | `scripts/w9_staging_probes.sh` + `scripts/w9_local_probes.sh` | Unit+Helm+local HTTP PASS; staging SKIP without URLs |

---

## Known soft PARTIALs (do not erase)

1. **W3** — F85 Actions secrets unverified; F12 Typesense 10M p95 (contract 10k CI GREEN)  
2. **W9** — live staging HTTP (local probe mode shipped; Typesense compose needs healthy docker)  
3. **W20–W23** — Playwright ChatSidebar goldens deferred (Clerk)  
4. **W24–W25** — live staging heal/promote dogfood soft  
5. **W27** — live stream staging p95 soft  
6. **W29** — npm still at **0.3.0**; PyPI **0.3.1** published  

*(W18 playground LLM stub removed — closed 2026-07-17.)*

---

## Authorization statement

I authorize the product claim:

> **Eden meets the in-scope SOTA production bar for security, observability, FinOps, Evaluate, ChatSidebar copilot, autonomy gates, MCP stretch, and SDK capability — subject to the PARTIALs above.**

I do **not** authorize claims of:

- Published **0.3.1** on **npm** until upload evidence exists (PyPI **0.3.1** is authorized)  
- F12 10M Typesense p95 proven (10k contract wiring is authorized)  
- Full Playwright Observe/Chat E2E green in CI without Clerk Actions evidence  
- Eden COGS / F22 / docs-site redesign (out of program)

---

## Evidence index

| Artifact | Path |
|---|---|
| Tracker | `docs/specs/SOTA-WAVE-TRACKER.md` |
| Market-ready report | `docs/specs/SOTA-MARKET-READY-REPORT.md` |
| Perf/cost scorecard | `docs/specs/SOTA-PERF-COST-SCORECARD.md` |
| Publish script | `scripts/publish_sdk.sh` |
| Portal sweep | `scripts/w29_portal_sweep.sh` |
| MCP smoke | `scripts/w29_mcp_smoke.sh` |
| W9 staging probes | `scripts/w9_staging_probes.sh` / `scripts/w9_local_probes.sh` |
| F12 contract CI | `.github/workflows/f12-span-search-contract.yml` |
| Flag/DR drills | `scripts/w29_flag_dr_drills.sh` |
| Packaging tests | `tests/unit/packaging/test_w29_packaging.py` |
| Portal W29 tests | `clients/portal/src/lib/__tests__/w29-portal.test.ts` |
