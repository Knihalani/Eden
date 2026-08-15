# CUT-INVENTORY — Eden Bloat Cut (Phase 1A–1D, 1F)

Running ledger of removed surfaces. Phase 1E (portal nav) is tracked separately.

**Cut date:** 2026-07-15  
**Plan:** `eden_bloat_cut_plan_ceaede64`

---

## Summary

| Category | Files removed | Routes/handlers cut (approx.) | Replacement |
|----------|---------------|-------------------------------|-------------|
| 1A Intelligence-gap stubs | 5 route files (partial) | ~19 | Live routes retained; OTel Collector / deferred docs |
| 1A In-memory alerts | 1 file | 2 | `/orgs/{org}/alerts` via `replay.py` + F81 NL alerts |
| 1B Cat 23 code_change | 62 files + 1 route file | ~46 | Salvaged `src/eden/patches/` (N23 spec) |
| 1C Legacy/niche routes | 7 files | ~25 | None / existing surfaces |
| 1D Placeholder hardening | 5 files (partial) | ~8 | Honest 501 or UI cut |
| 1F Detection dedupe | 2 files (behavioral) | 0 | Tiered pipeline in `trace_finalized_consumer` |

---

## 1A — Intelligence-gap stub routes (removed handlers)

| File | Removed routes | Reason | Replacement |
|------|----------------|--------|-------------|
| `intelligence_apm_depth.py` | `/sampling/*`, `/k8s/*`, `/profiles/*` (7) | §D.1 deferred OTel-collector redirects | `deploy/otel-collector-config.yaml` |
| `intelligence_predictive.py` | `/cost`, `/capacity`, `/risk`, `/drift/output`, `/drift/embedding` (5) | §D.3 deferred predictors | `/quality`, `/drift`; Cat 7 cost intel |
| `intelligence_user.py` | `/signals/return`, `/signals/copy-paste`, `/signals/retry` (3) | §D.2 removed trackers | Remaining 10 live user-intel routes |
| `intelligence_autonomous.py` | `/nl/query`, `/nl/dashboard` (2) | §D.4 NL query / auto-dashboard stubs | EQL DSL, saved dashboards |
| `intelligence_governance.py` | `/compliance/hipaa`, `/compliance/iso27001` (2) | §D.5 pack stubs | SOC2/GDPR routes retained |

### In-memory alerts (full file delete)

| Path | Reason | Replacement |
|------|--------|-------------|
| `src/eden/api/routes/alerts.py` | Global in-memory feed, no-op ack | `replay.py` `/orgs/{org}/alerts`; F81 `src/eden/alerts/` |

---

## 1B — Cat 23 autonomous code modification

### Deleted (full package)

| Path | Notes |
|------|-------|
| `src/eden/code_change/**` (62 files) | Entire Cat 23 stub package |
| `src/eden/api/routes/intelligence_code_change.py` | 46 API handlers |

**Legacy DB tables preserved** (no migration this pass): `proposed_patches`, `pr_patterns`, `pr_discipline_*`, `agent_activity_events`, etc.

### Salvaged → `src/eden/patches/`

| File | Purpose |
|------|---------|
| `issue_patch_trigger.py` | Issue → `proposed_patches` planning |
| `patch_generator.py` | Core diff generation |
| `pr_creator.py` | PR provider abstraction |
| `issue_fix_chat.py` | Chat-guided fix (`pr_url` mismatch fixed) |
| `_common.py` | Shared DB helpers, policy gates |
| `rca_linker.py` | RCA → file linking |
| `policy.py` | `get_org_code_change_policy` |
| `schedule_due.py` | Scheduled optimization due-check |

### Mounts / cron removed

| Location | Change |
|----------|--------|
| `app.py` | Dropped `intelligence_code_change.router` mount; added 410 Gone catch-all for `/orgs/{org_id}/intelligence/code-change/*` |
| `cron_tick.py` | Removed `evaluate_pending_clusters`, `scheduled_trigger`, `stale_pending_sweep`, `weekly_digest` |

**Replacement spec:** `docs/specs/features/n23-recurring-improvement-agent.md` (pending)

---

## 1C — Legacy / niche route files (full delete)

| File | Reason |
|------|--------|
| `experiments.py` | `experiments_v1=false`; no portal eval-harness nav |
| `chain.py` | Legacy chain surface |
| `integrations_helicone.py` | Gated legacy integration |
| `observability_computer_use.py` | D.12.3 niche |
| `observability_voice.py` | D.12.4 niche |
| `observability_fine_tune.py` | D.12.5 niche |
| `observability_provider_routing.py` | D.12.6 niche |
| `evaluation/eval_intel/versioner.py` | Back-compat shim; imports audited to package |

---

## 1D — Placeholder hardening

| Item | Action |
|------|--------|
| `sso.py` `/callback/{provider_id}` | Returns HTTP 501 + doc link (was fake success) |
| `compliance.py` export/delete | Returns HTTP 501 (was fake `queued`) |
| `judges.py` async path | Removed; `sync=false` → 501 |
| `kb.py` semantic/skills/exploits | Removed; episodic-only |
| `datasets/[id]/page.tsx` AI-fill UI | Removed (backend stub unchanged) |

---

## 1F — Detection pipeline dedupe

| File | Change |
|------|--------|
| `trace_finalized_consumer.py` | Tier order: Layer A → AutoIssueScanner → Signal investigator (skip F06 on Layer A primary hit) |
| `auto_scanner.py` | Removed `tool_error`, `loop`, `confusion_loop` from profiles (Layer A owns these) |
| `trace_finalized_consumer.py` | Layer A promotes `tool_error`/`looping`/`confusion_loop` descriptors to stumbles |

---

## Import updates (salvage consumers)

| Consumer | New import |
|----------|------------|
| `improve.py`, `agent_issues.py`, `orchestrator.py`, `closed_loop_executor.py` | `eden.patches.*` |
| `promotion_hooks.py` | `eden.patches.patch_generator`, `rca_linker`; revert advisory-only |
| `efficiency.py`, `triage_agent.py` | `eden.patches._common`, `policy`, `schedule_due` |

---

## Tests intentionally not updated (Cat 23 suite)

~~The following test modules reference deleted `eden.code_change` and will fail until removed or rewritten for N23:~~

**Resolved 2026-07-15 final cleanup** — all Cat 23 test imports removed or deleted.

---

## Cat 23 test cleanup (2026-07-15)

Removed obsolete tests that imported deleted `eden.code_change`:

- Deleted `tests/unit/code_change/` (entire tree, **27 files**)
- Deleted `tests/intelligence/test_intelligence_code_change_audit.py`, `test_intelligence_code_change_crud.py`, `test_intelligence_code_change_real.py`
- Deleted `tests/intelligence/test_autonomous_code_modification_stubs.py` (stub imports against removed package)
- Deleted `tests/integration/test_patch_flow.py`, `tests/integration/test_auto_mode_e2e.py` (Gate 4a/6 e2e against `eden.code_change`)
- Deleted `tests/intelligence/test_knowledge_graph_wiring.py` (CodebaseKnowledgeGraph not salvaged)
- Deleted `tests/unit/bench/test_repo_graph_bench.py` (SymbolGraph not salvaged)
- Updated `tests/intelligence/test_remediation_wave6.py`, `test_triage_agent.py`, `test_rca_accuracy.py`, `test_wave6_medium_features.py`, `test_f821_regression.py` → `eden.patches` / `eden.improvement`

**Kept:** `tests/intelligence/test_code_change_hook_wiring.py` (promotion_hooks advisory wiring; passes with `eden.patches` imports).

**Final deletion confirmation:**

| Path | Files removed |
|------|---------------|
| `src/eden/code_change/**` | **62** (59 Python modules + package `__init__` trees; git index) |
| `tests/unit/code_change/**` | **27** |
| Obsolete intelligence/bench tests (above) | **2** additional files |

**Post-cleanup run:** `pytest tests/intelligence/test_code_change_hook_wiring.py tests/intelligence/test_remediation_wave6.py tests/unit/closed_loop/test_efficiency.py tests/unit/alerts/ -q`
