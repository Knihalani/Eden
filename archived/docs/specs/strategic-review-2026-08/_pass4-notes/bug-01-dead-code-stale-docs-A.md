# Pass 4 — Agent A (Fact-Verifier & Pruner) notes on bugs/01-dead-code-stale-docs.md

Independently re-ran every grep/git check in the doc from scratch against the current working
tree (not trusting the doc's own "Round 3"/"Round 4"/"Phase 2 Verdicts" self-checks as ground
truth). Also cross-checked the doc's intro warning table against
`docs/specs/strategic-review-2026-08/KNOWN-SUBSYSTEMS.md`.

## VERIFIED (all held up exactly as claimed)

Every one of the 27 numbered dead-code/stale-doc items in the doc was independently
re-confirmed, with exact file:line and caller-count matches:

- **Backend orphans 1–10, 14–16, 20** (`record_shadow_feedback`, `run_investigator_llm_batch`,
  `list_plan_tiers`, `get_feature_list`, `fingerprint_from_detail`, `playbook_label`,
  `is_verify_worker_running`, `get_usage_service`, `is_consumer_running` (both copies),
  `_from_issues` (`improvement/agent.py:573` vs. `cockpit_aggregator.py:323` — confirmed genuinely
  different classes, not a naming collision), `_get_async_client_for_legacy_tests`,
  `_not_implemented_envelope` (metric_studio copy only — confirmed the other 5 per-package copies
  in `columnar/`, `patches/`, `time_travel/`, `autonomous/`, `dsl/` are real/distinct files),
  `register_intelligence_judges`, `leader_session`) — re-grepped every one both as a call-form
  (`name(`) and as a bare word (`\bname\b`) repo-wide; all show zero references outside their own
  `def` line (plus, where claimed, exactly the specific test-mock/docstring reference cited).
- **`register_providers_from_env`** (`llmops/ai_gateway.py:1579`) — confirmed zero production
  callers; `register_default_providers` alias only invoked from
  `tests/unit/llmops/test_ai_gateway_ollama.py` / `test_ai_gateway_providers.py`.
- **Router-mount sweep (item 21)** — independently reparsed `app.py`'s `_DEFERRED_ROUTERS` (96),
  `_DEFERRED_INTELLIGENCE_ROUTERS` (21), and the 7 immediate `app.include_router(...)` calls via a
  standalone script, diffed against all 125 `.py` files in `src/eden/api/routes/`
  (126 files minus `__init__.py`): **`mcp_keys` is the only file not accounted for by any of the
  three mount mechanisms** — 96+21+7=124, +1 unmounted = 125. Exact match to the doc's claim.
- **Item 22** (`createMcpKey`, `resources.ts:1855`) — confirmed zero callers in
  `clients/portal/src`.
- **Portal deprecated-but-dead exports (item 17)** — confirmed all 7 symbols
  (`DebuggerNotesView`, `DebuggerModeUrl`, `TraceTimelineMock`, `REMOVED_PORTAL_PATH_PREFIXES`,
  `STUB_CORE_SURFACE_IDS`, `FREE_TIER_PERSONAL_CAP_USD`, `FREE_TIER_ORG_CAP_USD`) carry an
  `@deprecated` JSDoc tag at the cited lines and have zero external callers; confirmed
  `trace-timeline-mock.tsx` is a 4-line re-export shim with zero repo-wide importers.
- **8 dead hooks (item 23)**, **13/17 dead constants in `portal-polish.ts` (item 24)**, **8 more
  dead exports (item 25)** — every individual name re-grepped, all confirmed single-file
  ("own def line only") hits. `ROLE_LABELS`/`ROLE_COLORS` in `use-permissions.ts` confirmed dead
  while the other 4 exports in that file are real.
- **Stale-docs items 2/11 (BulkActionBar), 3/12 (`wNN-portal.test.ts` deletion), 13 (W20
  router-mount reversal), 18 (`OPTIMIZATION-ID-CHECKLIST.md` K36/K37), 19 (SDK deletion
  staged-not-committed), 26 (`CODEBASE-GROUND-TRUTH.md`/`SOTA-PERF-COST-SCORECARD.md`/
  `SOTA-MARKET-READY-REPORT.md`/`GA-COMPLETION-CHECKLIST.md` fabricated-component recurrence), 27
  (`mcp-cursor.md` dead-endpoint instruction)** — every quoted string, line number, and git-log
  citation checked independently and matches exactly, including:
  - `git show --diff-filter=D --name-only cab7ae32` confirmed all 6 exact `wNN-*-portal.test.ts`
    filenames the doc cites as deleted.
  - `app.py:226` (`ai_insights.router`), `app.py:228-229` (`ai_agent.router`, with the exact
    "W20: Phase-C /ai chat..." comment), `app.py:329` (`target.include_router(...)`) — line
    numbers match precisely; `SOTA-WAVE-TRACKER.md:326` contains the exact quoted "Dual surface:
    aiApi deleted; ai_agent.router unmounted" text.
  - `git status --porcelain` reproduces the same 32 staged `D ` entries for `sdk/go/`, `sdk/rust/`,
    and the two CI workflow files described in items 18/19 (matches the conversation's own
    `gitStatus` snapshot).
  - `CODEBASE-GROUND-TRUTH.md:161,182`, `SOTA-PERF-COST-SCORECARD.md:14`,
    `SOTA-MARKET-READY-REPORT.md:40`, `GA-COMPLETION-CHECKLIST.md:141` all quoted verbatim and
    correct; `clients/portal/src/components/portal-os/` confirmed absent; of the ten U00 symbols,
    the doc's "6 zero-match / 4 real-under-different-names" split reproduced exactly (`AppShell` →
    `components/shell/app-shell.tsx`, `MobileBottomNav` → `components/shell/mobile-nav.tsx`).
- **`ruff check --select F401,F811,F841 --isolated`** on the four cited trees: re-ran it myself,
  reproduces "All checks passed!" (zero findings), matching the doc's claim.
- **`is_consumer_running`, `_from_issues`, `register_intelligence_judges` self-documented no-op
  framing** — docstrings quoted in the doc match the actual source text verbatim.
- Spot-checked the doc's *negative* claims (functions asserted NOT dead):
  `run_auto_eval`, `upsert_budget`, `send_test_message`, `notify_pr_opened`, `route_playbook`,
  `notify_issue_detected`, `list_actions` — all have ≥2 repo-wide hits (real callers beyond the
  `def` line), consistent with the doc's "these were false positives in an earlier pass" note.
- Minor/non-bugs section: `heartbeats.py:17` / `postgres.py:480` TODO duplication, `billing.py:721`
  correct-deprecation pattern, and the `metric_studio/registry.py` / `pii_intl.py` /
  `faker_vault.py` domain-vocabulary claims all confirmed accurate on direct read.
- Cross-checked the intro table's module-existence claims (`evaluation/golden_dataset.py`,
  `playground/llm_handler.py`, `guardrails/evaluator.py`, `sdk/a2a.py`,
  `services/observability/a2a_links.py`, `alerts/__init__.py`, `replay/store.py`,
  `analytics/funnels.py`, `time_travel/recorder.py`, etc.) against the filesystem — all exist as
  claimed, and none of this doc's actual dead-code findings (items 1–27) touch any of the
  substantive subsystems `KNOWN-SUBSYSTEMS.md` flags as real (`guardrails/`, `optimization/`,
  `improvement/`, `time_travel/`, `nudges/`, `automations/`, `playground/`, `datasets/`) — round 4
  explicitly swept `guardrails/policy.py`, `guardrails/evaluator.py`, and `time_travel/_common.py`
  and found them clean/wired, which is consistent with (not contradicting) the ground-truth doc.
  **No case found where this doc mistakes a real, wired subsystem for dead code** — the scope
  warning at the top of the doc did its job.

## CUT

1. **Item 23's claim about `useUrlSearch`** (`hooks/use-url-state.ts:67`): *"sibling export
   `useUrlState` in the same file is real and used elsewhere; only this one named export is
   dead."* — **This is factually wrong and should be corrected, not just pruned.**
   `grep -rln "use-url-state" clients/portal/src` returns **zero files** — nothing in the repo
   imports from `hooks/use-url-state.ts` at all, and `grep -rln "\buseUrlState\b"
   clients/portal/src` likewise returns only the file's own `def`/docstring lines. The file's
   docstring recommends a `useUrlStateMulti` as the preferred alternative "for multiple keys," but
   that name doesn't exist anywhere either (only mentioned in the comment). **The entire
   `use-url-state.ts` file (both `useUrlState` and `useUrlSearch`) is dead, not just the one named
   export the doc singles out.** This actually *strengthens* item 23 (one more dead export than
   claimed) but the specific "sibling is real and used elsewhere" sentence is false and should be
   struck/corrected in the merged doc.

2. **The "CRITICAL — scope warning" intro block, lines 3–32** (the `F02`/`F03`/`F08`/.../
   "eden lacks X" contradiction table plus "Recommend a dedicated fork...before finalizing
   INDEX.md"): every module-existence claim in it checks out on direct filesystem check, so it's
   not *false* — but it is now **wholly superseded by `KNOWN-SUBSYSTEMS.md`**, which exists
   specifically because this warning (and others like it) were raised earlier in the review. Per
   the task's own framing ("several early docs in this review were written before this inventory
   existed"), this ~30-line table duplicates content the ground-truth doc now owns canonically.
   Recommend collapsing to one line ("see `KNOWN-SUBSYSTEMS.md` — do not re-litigate module
   existence here") in the Phase-2/final synthesis rather than carrying the full table forward.

3. **Structural redundancy across "Round 3" (lines 193–230), "Phase 2 Verdicts" (lines 330–411),
   "Round 3 summary" (413–428), and "Round 4 summary" (612–631)** — these four sections
   re-state the same conclusions for items 1–19 (and later 1–27) two to four times each, in
   near-identical prose ("VERDICT: CONFIRMED REAL... exact file:line... zero corrections"), adding
   verification-log theater rather than new information. Every fact in these sections is *true*
   (I independently re-confirmed the underlying claims myself), but as content for a final-pass
   synthesis doc, this is filler that should collapse to a single verdict list per item, not four.
   Not flagging any individual sentence as false — flagging the section-level duplication as
   prunable bulk. Quote representative of the pattern: *"Re-verified every citation in this file
   against the current working tree (grep/git-log, not trusted from the report). All findings
   confirmed real; no false positives found in this file."* — this sentence (or a close paraphrase
   of it) appears, in substance, at the start of the "Round 3", "Phase 2 Verdicts", "Round 3
   summary", and "Round 4 summary" sections.

## NEW FINDINGS

1. **`AIGateway()` instantiation count is undercounted in item 16's discussion (line 225-227).**
   The doc says *"The two real `AIGateway()` instantiations (`api/routes/gateway.py:332`,
   `api/routes/llmops.py:42`) never call either registration function, confirming `_providers`
   starts and stays empty in production."* There is in fact a **third** instantiation site,
   `src/eden/llmops/learn_wiring.py:49` (`gateway = AIGateway()`), inside a `try/except` fallback
   path in `install_learn_filters()` that only fires if importing the shared `_ai_gateway` singleton
   fails. It also never calls `register_providers_from_env`/`register_default_providers`, so the
   doc's underlying conclusion (production `_providers` stays empty) is **not invalidated** — but
   "the two real instantiations" is an undercount; there are three, one of which is a rare
   exception-path fallback. Low severity, worth a one-line correction, not a retraction.

2. **The `is_verify_worker_running`, `playbook_label`, `fingerprint_from_detail`, and
   `leader_session` orphan claims survive an extra check the doc's methodology described but I
   independently re-ran**: bare-word grep (`\bname\b`, not just `name(`) across `src`, `tests`,
   `scripts`, `clients`, to rule out non-call references (e.g. passed as a bare callback/dict
   value without trailing parens, or used in a `Depends(name)`-style FastAPI wiring). All four
   still show zero references outside their own `def` line — no hidden wiring found. This doesn't
   change any verdict, just adds a stronger confirmation basis than "Round 4"'s own methodology
   description implied it always did per-item.

3. **No conflict found between this doc's dead-code claims and `KNOWN-SUBSYSTEMS.md`.** I checked
   every subsystem `KNOWN-SUBSYSTEMS.md` flags as "already confirmed substantive"
   (`guardrails/`, `optimization/`, `improvement/`, `time_travel/`, `nudges/`, `automations/`,
   `playground/`, `datasets/`) against this doc's 27 dead-code items and none overlap — this doc's
   findings are narrow, single-function/single-export orphans inside otherwise-live modules
   (e.g., one dead helper in `closed_loop/verify.py`, not the whole `closed_loop/` package), which
   is consistent with, not contradicted by, the ground-truth inventory. Confirms this doc did not
   fall into the "misunderstood-as-dead subsystem" trap the task description warned about.

## Summary

27/27 numbered claims in the doc independently re-verified as accurate against current source
(file:line and caller-count exact matches). One genuine factual error found and flagged for
correction (item 23's "`useUrlState` sibling is real and used elsewhere" — it is not; the whole
file is dead). One minor undercount (AIGateway instantiation sites: 3, not 2 — doesn't change the
conclusion). Main pruning recommendation is structural: the doc's intro scope-warning table
(now redundant with `KNOWN-SUBSYSTEMS.md`) and its four near-duplicate self-verification rounds
should be collapsed for the final synthesis; none of the substantive dead-code/stale-doc content
itself needs to be cut.
