# Bug Sweep: Dead Code & Stale Docs

**Scope note:** see `docs/specs/strategic-review-2026-08/KNOWN-SUBSYSTEMS.md` for the canonical
inventory of which `src/eden` subsystems are real/substantive vs. unexplored. An earlier draft of
this doc carried a ~30-line scope-warning table here (a `features/` "eden lacks X" vs.
`evaluation/`, `playground/`, `guardrails/`, `time_travel/`, etc. contradiction table). Every
module-existence claim in that table checked out, but it is now wholly superseded by
`KNOWN-SUBSYSTEMS.md`, which exists specifically to own this ground — do not re-litigate module
existence here. None of the dead-code items below touch a subsystem `KNOWN-SUBSYSTEMS.md` flags
as substantive (`guardrails/`, `optimization/`, `improvement/`, `time_travel/`, `nudges/`,
`automations/`, `playground/`, `datasets/`) — every finding here is a narrow, single-function or
single-export orphan inside an otherwise-live module, not a misidentified subsystem.

## Methodology

AST-parsed every top-level public function/export across `src/eden/{services,issues,signals,
closed_loop,insights,workers,alerts}` (plus spot checks of `guardrails/`, `time_travel/`) and did
a full `export function|const|class` sweep of `clients/portal/src` (1,010 top-level exports, 213
with only one repo-wide referencing file, 42 hand-verified). Every candidate was grepped repo-wide
(`src`, `tests`, `scripts`, `clients`) for both the call form (`name(`) and the bare word
(`\bname\b`), to rule out non-call references (decorators, string/registry dispatch,
`Depends(name)`-style FastAPI wiring, dynamic `importlib`/`pkgutil` auto-mounting, and
`import X as Y` aliasing) before anything was called dead. Stale-docs claims were checked directly
against `git log`/`git show`/`git status`, not trusted from prior tracker text.

This doc has been independently re-verified across four review passes, each re-running the greps
from scratch rather than trusting the prior pass's conclusions. As of this pass (pass 4), all 27
numbered items below were re-confirmed against current source with exact file:line and
caller-count matches. Two corrections came out of this pass: item 23's `useUrlSearch` entry
wrongly claimed a sibling export was "real and used elsewhere" (it is not — see item 23), and the
`register_providers_from_env`/`AIGateway` note undercounted real instantiation sites (see below).
No item was cut, and no case was found where this doc mistakes a real, wired subsystem for dead
code.

One false positive was caught and discarded before ever being reported: `supervise`
(`src/eden/workers/supervisor.py:26`) initially looked dead via call-form grep (`\bsupervise\(`
finds only its own `def`), but `src/eden/workers/main.py:76` imports it under an alias
(`from eden.workers.supervisor import supervise as _shared_supervise`) and calls
`_shared_supervise(...)` at `main.py:154` — real and live, just alias-renamed at the import site.
Kept as a reminder that call-form grepping without checking `import X as Y` misses real callers;
every item below was individually re-checked for aliasing before being listed.

Also ruled out as false positives from an earlier pass (real callers once same-file call sites
were correctly counted): `run_auto_eval`, `upsert_budget`, `send_test_message`,
`notify_pr_opened`, `route_playbook`, `notify_issue_detected`, `list_actions` — all have ≥2
repo-wide hits (real callers beyond the `def` line); not bugs.

## Confirmed dead code — backend (`src/eden`)

1. **`record_shadow_feedback`** (`src/eden/services/soft_issue_review.py:571`) — 3 hits total
   repo-wide (`def` L571, a debug-log self-reference at L617, `__all__` export at L649), zero
   external callers.
2. **`run_investigator_llm_batch`** (`src/eden/signals/investigator.py:158`) — worse than a plain
   orphan: `tests/unit/signals/test_f35_investigator.py:140` `patch()`es this exact dotted path
   inside `test_multi_schema_heuristics_no_llm_batch`, asserting it is *not* called on the
   no-batch path — but grepping `investigator.py` for `run_investigator_llm_batch(` turns up only
   the `def` line. The positive-path call the test's own name implies should exist elsewhere was
   apparently never wired in (or was removed); only 2 repo-wide hits total (def + the `patch()`
   target), no production call site.
3. **`list_plan_tiers`** (`src/eden/services/plan_tiers.py:281`) — sibling function
   `list_public_plan_tiers` (line 276, same file) is the one actually used, with a real caller
   (`tests/unit/billing/test_free_only.py:28`); this one (paid placeholders included) has no
   caller — 1 hit (def only).
4. **`get_feature_list`** (`src/eden/services/plan_tiers.py:286`) — 1 hit (def only).
5. **`fingerprint_from_detail`** (`src/eden/issues/fingerprint.py:92`) — convenience wrapper
   around `compute_fingerprint`/`error_signature_for`; nothing calls the wrapper itself. 1 hit
   (def only).
6. **`playbook_label`** (`src/eden/closed_loop/playbooks.py:53`) — a label lookup table for
   playbook action types (`rollback`, `reweight`, `cache_bust`, ...) that no UI/API code renders.
   1 hit (def only).
7. **`is_verify_worker_running`** (`src/eden/closed_loop/verify.py:810`) — status-check helper for
   the closed-loop verify worker's background task; no health-check or route reads it. 1 hit (def
   only).
8. **`get_usage_service`** (`src/eden/services/usage_service.py:538`) — the module's own singleton
   accessor (`async def get_usage_service() -> UsageService`) has zero callers; 1 hit (def only).
   `src/eden/api/middleware/quota_enforcement.py` independently defines and calls its own private
   `_get_usage_service` method (L171, called at L487/L553) instead — the intended service-locator
   pattern looks abandoned mid-refactor in favor of a duplicate, independent path.
9. **`is_consumer_running`** (`src/eden/closed_loop/event_bus.py:486`) — 1 hit (def only). A
   same-named but unrelated function also exists in
   `src/eden/workers/trace_finalized_consumer.py:772` — that one is dead too by the same grep, but
   is a distinct implementation, not a shared/duplicate call site.
10. **`_from_issues`** (`src/eden/improvement/agent.py:573`) — orphaned, not a naming-collision
    false positive. Docstring: *"Deprecated empty-card path — kept for tests; returns []."* — the
    `ImprovementAgent` class has zero `self._from_issues` call sites anywhere in that file; only
    the sibling `self._from_traces` (line 579) feeds the `asyncio.gather(...)` stage list at
    L320-322. The `self._from_issues(...)` call at `cockpit_aggregator.py:214` resolves to a
    **different** class's own method (`ImprovementCockpitAggregator._from_issues` at
    `cockpit_aggregator.py:323`), confirmed by checking both files' `class` boundaries. The
    Improvement Agent's plan-candidate generation therefore has only one live signal source
    (traces); the "from Issues" path is a permanently no-op stub kept for test compatibility.
14. **`_get_async_client_for_legacy_tests`** (`src/eden/api/routes/gateway.py:1022`) — zero call
    sites anywhere; exact call-form grep (`_get_async_client_for_legacy_tests(`) across `src` +
    `tests` returns exactly 1 hit, the `def` itself. Its own docstring (L818) only *mentions* the
    function's name in prose ("is in `_get_async_client_for_legacy_tests`") — despite claiming to
    be "the read-side bridge" that lets legacy tests keep passing, the bridge appears unused even
    by the tests it claims to serve.
15. **`_not_implemented_envelope`** (`src/eden/metric_studio/_common.py:81`) — a per-module
    private helper; each of `columnar/`, `patches/`, `time_travel/`, `autonomous/`, `dsl/` defines
    its own identically-named `_not_implemented_envelope` in that package's `_common.py`, and
    those five sibling copies all have real in-package callers. `metric_studio/`'s copy is the one
    exception: zero callers anywhere in `src/eden/metric_studio/*.py`, and no cross-package import
    of it exists (metric_studio's tests only import a different helper, `_check_auto_judge_policy`,
    from the same file).
16. **`register_intelligence_judges`** (`src/eden/llmops/judges/builtin_v9.py:17`) — same pattern
    as item 10: a self-documented permanent no-op. Module docstring: *"`register_intelligence_judges`
    is a no-op kept for call-site compatibility (tests / docs that still import it). Defaults are
    registered via `register_default_judges`."* The function body just logs a debug line and
    returns `0`. Only reference outside its own file is
    `tests/intelligence/test_intelligence_gap_stubs.py:205,210`, which imports it and asserts it
    returns `0` — the test exists purely to pin the no-op behavior, not to exercise a real code
    path. No string-keyed judge-registry dispatch (`JUDGE_REGISTRY`) calls it reflectively either.
20. **`leader_session`** (`src/eden/workers/leader.py:25`, an `@asynccontextmanager`) — zero
    callers anywhere in `src`/`tests`/`scripts`, checked both as a direct call (`leader_session(`)
    and via an exhaustive review of every `from eden.workers.leader import ...` reference
    repo-wide (30+ hits for the module, none touching this name, no alias-import escape hatch).
    The module's actively-used leader-election primitive is the free function `run_if_leader` (14
    real call sites, including `src/eden/workers/main.py:542,598,631,668,755,804`);
    `leader_session` is a second, parallel "acquire a lock for the duration of an `async with`
    block" API that nothing in the codebase ever entered.
21. **`src/eden/api/routes/mcp_keys.py`'s router is never mounted.** Parsed `app.py`'s three mount
    mechanisms exhaustively: `_DEFERRED_ROUTERS` (96 modules), `_DEFERRED_INTELLIGENCE_ROUTERS`
    (21 modules), and the 7 immediately-`include_router`'d modules (`auth`, `ingestion`,
    `ingest_agent_sessions`, `app_events`, `gateway`, `gateway_models`, `gateway_analytics`) — 124
    of the 125 `.py` files under `src/eden/api/routes/` are accounted for by exactly one of these
    three lists. **`mcp_keys` is the single exception**: zero occurrences of `mcp_keys` in any
    form anywhere in `app.py`. Also checked `src/eden/api/routes/__init__.py`'s `importlib`-based
    `__getattr__` (PEP 562) as a possible dynamic auto-mount escape — it's lazy-import-on-access
    only, it never calls `include_router()`; no `pkgutil`/`iter_modules` auto-registration exists
    anywhere under `src/eden/api/`. The router (`mcp_keys.py:18-27`,
    `prefix="/orgs/{org_id}/mcp/keys"`), including `POST ""` (create an MCP-scoped key) and
    `list_mcp_keys` (`:71`, `GET ""`), is therefore unreachable via any real HTTP request in
    production — fully implemented, simply never `include_router()`'d. The only code that
    exercises these handlers is unit tests calling the async handler functions directly
    (`tests/unit/api/test_w7_1_api_auth_orgs_rbac.py:285,298,321`,
    `tests/unit/api/test_worker1_auth_bugs_jul19.py:26,184`), bypassing FastAPI routing entirely —
    so the tests pass even though the HTTP surface they're meant to protect (per
    `test_worker1_auth_bugs_jul19.py`'s own docstring, "mcp_keys path-scoped admin (IDOR via
    Header-only Depends)") was never actually mounted for a real request to reach.

**Also dead, via the same methodology (not part of the 1–27 numbered set, first surfaced in
`INDEX.md`):** `register_providers_from_env` (`llmops/ai_gateway.py:1579`) — zero production
callers; the module's own "backwards-compatible alias" `register_default_providers` (`:1656`,
which just calls `register_providers_from_env(gateway)`) is *also* only invoked from
`tests/unit/llmops/test_ai_gateway_ollama.py` and `test_ai_gateway_providers.py` — the alias
doesn't rescue it into a live path. There are **three** real `AIGateway()` instantiation sites,
not two as an earlier pass of this doc stated: `api/routes/gateway.py:332`,
`api/routes/llmops.py:42`, and a third at `src/eden/llmops/learn_wiring.py:49`
(`gateway = AIGateway()`), inside a `try/except` fallback path in `install_learn_filters()` that
only fires if importing the shared `_ai_gateway` singleton fails. None of the three ever call
`register_providers_from_env`/`register_default_providers`, so the underlying conclusion is
unchanged: `_providers` starts and stays empty in production.

`ruff check --select F401,F811,F841 --isolated` on `src/eden/services`, `src/eden/issues`,
`src/eden/signals`, `src/eden/closed_loop` reports **zero** unused imports/redefinitions/unused
locals — no linter-flagged dead code in these trees (repo has no `pyproject.toml` lint-rule
config beyond defaults, confirmed by running `--isolated`).

## Confirmed dead code — portal (`clients/portal/src`)

17. **Portal-side dead-but-correctly-`@deprecated`-labeled exports** — correctly labeled
    deprecated (good practice, same pattern as the `billing.py` route in "Minor / non-bugs" below)
    but, unlike that route, have **zero remaining callers at all** rather than a shrinking-but-
    nonzero one — fully removable today, not genuinely still-transitioning:
    - `DebuggerNotesView` (`lab/debugger/debugger-modes.tsx:1402`) — 1 hit (own `export function`).
    - `DebuggerModeUrl` (`lab/fixtures/debugger.ts:23`) — 1 hit (own `export type`).
    - `TraceTimelineMock` (`components/marketing/product-surface-mock.tsx:238`) — 2 hits: its own
      def, plus a re-export in `components/marketing/trace-timeline-mock.tsx`. **That re-export
      file itself has zero importers anywhere in the repo** — a dead 4-line shim
      (`export { ProductSurfaceMock, TraceTimelineMock } from
      "@/components/marketing/product-surface-mock";`) wrapping already-dead code.
    - `REMOVED_PORTAL_PATH_PREFIXES` (`lib/portal-routes.ts:46`) — 1 hit (def only).
    - `STUB_CORE_SURFACE_IDS` (`lib/sidebar-config.ts:70`) — 1 hit (def only).
    - `FREE_TIER_PERSONAL_CAP_USD` / `FREE_TIER_ORG_CAP_USD` (`lib/constants.ts:27,29`) — 1 hit
      each (def only).
22. **Portal-side companion to item 21**: `clients/portal/src/lib/api/resources.ts:1855`
    (`createMcpKey: (orgId: string, name = "MCP", scopes?: string[]) => ...`) calls
    `POST /orgs/${orgId}/mcp/keys` — the exact unmounted endpoint from item 21 — and has **zero
    callers anywhere in the portal UI** (`rg -rln "createMcpKey" clients/portal/src` returns only
    `resources.ts` itself). The entire MCP-scoped-key-issuance feature is dead end-to-end: an
    implemented-but-unmounted backend router, a client wrapper nothing in the UI ever calls, and
    (item 27) a public how-to doc that tells users to call it anyway.
23. **Eight custom hooks with zero importers anywhere in the portal** (each has exactly one
    file-hit repo-wide — its own `export function`/`export const` line — via
    `rg -c "\bname\b" clients/portal/src`, ruling out same-file self-use and import aliasing):
    - `useOnline` (`hooks/use-online.ts:11`)
    - `useListKeyboardNav` (`hooks/use-list-keyboard-nav.ts:19`)
    - `useQueryTab` (`hooks/use-query-tab.ts:7`)
    - `usePortalChromeEffects` (`hooks/use-portal-chrome-effects.ts:2`) — self-documented no-op,
      same pattern as `_from_issues`/`register_intelligence_judges`: the file's only comment reads
      `/** No-op during greenfield — portal chrome removed. */` directly above the export.
    - `useUrlSearch` (`hooks/use-url-state.ts:67`) — **correction (pass 4):** an earlier pass of
      this doc claimed "sibling export `useUrlState` in the same file is real and used elsewhere;
      only this one named export is dead." That is false. `grep -rln "use-url-state"
      clients/portal/src` returns **zero files** — nothing in the repo imports from
      `hooks/use-url-state.ts` at all, and `grep -rln "\buseUrlState\b" clients/portal/src`
      likewise returns only the file's own `def`/docstring lines. **The entire
      `use-url-state.ts` file is dead — both the `useUrlState` and `useUrlSearch` exports —**
      not just the one named export originally singled out. (The file's docstring recommends a
      `useUrlStateMulti` as the preferred alternative "for multiple keys," but that name doesn't
      exist anywhere either, only in the comment.)
    - `useWorkspaceMode` (`hooks/use-workspace-mode.ts:15`) — the file's sole export.
    - `useOrgMutation` (`hooks/use-api-query.ts:106`)
    - `useLiveTraceStream` (`hooks/use-live-trace-stream.ts:33`)
24. **`clients/portal/src/lib/portal-polish.ts` — 13 of its 17 exported constants are dead** (only
    `U20_EMPTY_COPY`, `U20_FILTER_EMPTY_COPY`, `FIRST_EVENT_WAIT`, and `U20_TOAST_MUTATIONS` — the
    last used only in-file as a `typeof` type source at `:117` — have any reference outside their
    own `export const` line): `U20_CORE_AXE_ROUTES` (`:10`), `U20_SERIOUS_AXE_ROUTES` (`:28`),
    `U20_TOAST_MUTATION_SOURCES` (`:117`), `U20_MOTION_CLASSES` (`:134`), `W11_OS_HUBS` (`:141`),
    `WAVE11_LIST_KEYBOARD_HUBS` (`:152`), `WAVE_E6_LIST_KEYBOARD_HUBS` (`:160`),
    `WAVE11_MOBILE_CARD_SURFACES` (`:167`), `WAVE12_LOOP_ROUTES` (`:184`),
    `WAVE12_PORTAL_ROUTE_COUNT` (`:194`), `WAVE12_VISUAL_BASELINE_IDS` (`:197`),
    `WAVE12_PEER_VISUAL_REFS` (`:212`), `WAVE12_CHROME_SINKS` (`:222`). The file's own docstring
    (`:1-2`) says it holds "shared constants for a11y CI, microcopy, and toast audit," and the
    naming convention (`W11_`, `WAVE11_`, `WAVE12_`, `WAVE_E6_`, `U20_`) matches the exact
    wave-numbering vocabulary `SOTA-WAVE-TRACKER.md` uses for W10–W29 — strongly suggesting these
    were CI-audit fixtures consumed by the same `wNN-portal.test.ts` evidence suite item 12 below
    found was deleted wholesale in `cab7ae32` (plausible causal link, not confirmed via
    `git blame`) — but the current-state fact stands regardless of cause: nearly 80% of this
    file's public API is unreachable code.
25. **Eight more dead exports outside `portal-polish.ts` and the hooks above**, all confirmed
    zero-file-external-reference: `AbStatusChip` (`lab/compare/compare-chrome.tsx:60`),
    `GuardrailsTabNav` (`lab/guardrails/guardrails-chrome.tsx:44`), `GuardrailsTestView`
    (`lab/guardrails/guardrails-detail-view.tsx:129`), `SectionHead` (`lab/lab-ui.tsx:132`),
    `NavToggle` (`lab/lab-ui.tsx:37`), `MarketingPage` (`components/ds/marketing-page.tsx:8`),
    `GRADE_LABELS` (`lib/compare-grades.ts:142`), and a pair inside `use-permissions.ts`:
    `ROLE_LABELS` (`:118`) / `ROLE_COLORS` (`:126`) — 2 of that file's 6 exports are dead, the
    other 4 (including the hook itself) are real.

    (213 candidates were generated by the portal export/usage sweep; the 21 named in items 17/25
    plus the 8 hooks (item 23) and 13 `portal-polish.ts` constants (item 24) — 42 total — were the
    ones hand-verified. The remainder are predominantly `lab/fixtures/*.ts` helper functions (test/
    demo fixture data for the `lab/` sandbox surface) following the same "1 file hit" pattern but
    not individually verified for this report — worth a dedicated follow-up pass if `lab/` cleanup
    becomes a priority.)

**Trees checked and found clean:** `src/eden/insights/*.py` (16 functions), `src/eden/alerts/*.py`
(`compiler.py`, `repo.py`, `routes.py`), spot checks of `guardrails/policy.py`,
`guardrails/evaluator.py`, `time_travel/_common.py` — every top-level public function has a real
caller, including cases that initially looked suspicious from a same-file-only grep
(`compute_psi` called from `DriftReportBuilder` in the same file; classes flagged as "1 hit" by a
naive constructor grep — `ComparativeAnalysisEngine`, `DatasetGenerationEngine`,
`DriftBaselineWorker`, `TraceNormalizer` — are each instantiated exactly once inside
`InsightsService.__init__` or `cron_tick.py:556`, which is a real call site, not zero).

## Stale-docs findings

11. **`BulkActionBar` does not exist anywhere in the repository** — unrestricted repo-wide grep
    (`**/*.tsx`, `**/*.ts`, excluding node_modules): zero matches. Yet `docs/specs/
    SOTA-WAVE-TRACKER.md` claims it shipped at L49 (W11), L50 (W12), and L301 (Promotions
    section) — the literal string appears at exactly these 3 locations (an earlier pass of this
    doc cited a 4th, L54/W16, which actually reads "Bulk triage/resolve wired" and doesn't
    literally say "BulkActionBar" — downgraded to 3 literal citations, core finding unaffected).
    Three independent claims about the same nonexistent component is a pattern, not a typo — treat
    every "GREEN" status in this tracker as unverified until spot-checked. The tracker's own W29
    entry is honest about a real gap elsewhere ("npm `@eden-ai/sdk` still 0.3.0 — stale
    `~/.npmrc` → 401"), so it isn't uniformly fabricated, which makes the BulkActionBar pattern
    more concerning, not less — it shows the doc mixes verified and unverified claims with no
    visible distinction.
12. **The entire `wNN-portal.test.ts` evidence suite `SOTA-WAVE-TRACKER.md` cites for waves
    W10–W29 was deleted from the working tree in commit `cab7ae32`** ("feat(portal): complete live
    API wire-up for production", 2026-07-23) and never replaced or re-cited. Confirmed via
    `git show --diff-filter=D --name-only cab7ae32` (`w10-w12-portal.test.ts`,
    `w13-w17-portal.test.ts`, `w19-portal.test.ts` through `w29-portal.test.ts`,
    `w3-ia-portal.test.ts`, `w7-evals-portal.test.ts`, and others) and by unrestricted repo-wide
    `find`/`grep`: none of these files, and none of the specific component names the tracker cites
    as their contents, exist anywhere in `clients/portal/src`. Spot-checked beyond W11/W16:
    - **W13** (`SOTA-WAVE-TRACKER.md:51`, claims `TranscriptV2`+swimlanes, `RrwebThumb`,
      `MessageCards`, `TraceDetailPanel`, `CrossLinkBar`) — zero matches for any of those names.
      Transcript functionality does still exist, under different, unrelated names
      (`lib/observability/build-transcript-rows.ts` / `lab/run-transcript.test.tsx`) — looks like
      a real rewrite, not a feature loss, but the tracker's evidence citations are unverifiable as
      written.
    - **W14** (`:52`, claims `SpanSearchBar`) — zero matches anywhere. `QueryFilterBar` has exactly
      one repo hit, and it's not a component: `lib/portal-polish.ts:140`, a comment
      (`/** Hubs that must ship QueryFilterBar + Views + export OS (W11). */`) — the only
      surviving "evidence" is a TODO-style comment saying it's required, not that it shipped.
    - **W15** (`:53`, claims `SessionsTab`) — zero matches anywhere.
    - Not every claim is wrong: **W18**'s "Real playground LLM via ModelRouter" (`:56`) is
      verified true (`src/eden/playground/llm_handler.py:1,88`). **W20**'s "`aiApi` deleted" half
      checks out (zero `aiApi` matches repo-wide), but its "`/ai` unmounted" half does not — see
      item 13.
    - **Implication**: ~20 of the ~30 rows in the tracker cite a `wNN-*-portal.test.ts` file that
      no longer exists post-`cab7ae32`. Some underlying features may have been renamed/rewritten
      (as with W13) rather than dropped — but as written, the evidence trail cannot be verified
      and should be re-audited row by row, not trusted as GREEN.
13. **`SOTA-WAVE-TRACKER.md:326` (Wave 20 exit review) claims "Dual surface: aiApi deleted;
    ai_agent.router unmounted"** — the opposite is true in the running code:
    - `src/eden/api/app.py:228-229` mounts `("eden.api.routes.ai_agent", "router")` in the
      deferred mount table, with the comment **"W20: Phase-C /ai chat for the portal assistant
      panel"** — i.e. `ai_agent.router` was *added*/mounted as part of W20, not unmounted.
    - This deferred mount table is genuinely applied (`app.py:329`,
      `target.include_router(getattr(mod, attr))`), so it isn't an inert list.
    - `ai_insights.router` (`app.py:226`, `/orgs/{org_id}/ai-insights`) is *also* still mounted at
      the same time — both the old and new chat surfaces are live simultaneously; the "dual
      surface" the doc claims was eliminated in W20 is, per the code, still dual.
    - The one part of the W20 claim that does check out: no `aiApi` file exists anywhere under
      `clients/portal/src` (consistent with "aiApi deleted").
    - Net effect: the "unmounted" claim is not just unverifiable, it is contradicted by an inline
      code comment from the same wave that says the opposite.
18. **`docs/specs/OPTIMIZATION-ID-CHECKLIST.md:32-33` still marks Go/Rust SDK optimizations
    "DONE" for SDKs that no longer exist in the repo at all.** Rows `K36` ("Go SDK queue+batch
    flush") and `K37` ("Rust send_batch raw JSON array") are both `DONE`, but `sdk/go/` and
    `sdk/rust/` (and their CI workflows `.github/workflows/sdk-go-ci.yml`, `sdk-rust-ci.yml`) were
    deleted from the working tree wholesale (confirmed via `git status`, all staged deletions).
    Not wrong as a historical record, but as written it reads as "these SDKs are live and
    optimized," which is now false. Recommend annotating K36/K37 as moot/superseded, consistent
    with how `SOTA-WAVE-TRACKER.md:115,163` already correctly marks the Go/Rust SDK rows
    **DELETED** / **N/A**.
19. **The `sdk/go`/`sdk/rust` deletion is currently staged, not yet committed to `main`.** `git
    status --porcelain` shows 32 `D ` entries (`sdk/go/*`, `sdk/rust/*`, and the two CI workflow
    files) as staged deletions, not committed. Doesn't make item 18 wrong — the working tree,
    which is what a developer actually sees, has them gone — but means anyone running `git log`/
    `git show HEAD:sdk/go` today would still find the old files, and the deletion could still be
    reverted before commit. `SOTA-WAVE-TRACKER.md` and `docs/specs/strategic-review-2026-08/
    sdk-deletion.md` both already correctly describe the deletion as accomplished, which is
    accurate for the working tree but should be read as "staged, pending commit," not "shipped to
    main." No other stale `sdk/go`/`sdk/rust` references were found: root `README.md` already only
    describes Python/TypeScript SDKs, and `docs/docs/**` has zero Go/Rust SDK references.
26. **The `BulkActionBar`/`TranscriptV2`/`SpanSearchBar` fabrication (items 11-12) is not confined
    to `SOTA-WAVE-TRACKER.md`** — the same names independently recur in at least four other
    `docs/specs/` tracking docs:
    - **`docs/specs/CODEBASE-GROUND-TRUTH.md:161`** — claims "U00 portal-os | SHIPPED (v0)" at
      `clients/portal/src/components/portal-os/`, listing nine named components/hooks including
      `BulkActionBar`. **The directory does not exist at all.** Of the ten named symbols, six have
      zero matches anywhere in the repo (`ResourcePageShell`, `CoreResourcePage`,
      `DetailPanelShell`, `DensityProvider`, `InfiniteDataTable`, `BulkActionBar`); the other four
      exist as real code under different names — `AppShell` → `components/shell/app-shell.tsx`,
      `MobileBottomNav` → `components/shell/mobile-nav.tsx`, `ViewsMenu` most likely refers to
      `SavedViewsMenu` (`components/portal/saved-views-menu.tsx`, substring match only), and
      `QueryFilterBar` is (item 12) only a comment, not a component.
    - **`docs/specs/CODEBASE-GROUND-TRUTH.md:182`** — same doc, "N10 Search→signal | SHIPPED —
      `SpanSearchBar` save button." Zero matches for `SpanSearchBar` anywhere.
    - **`docs/specs/SOTA-PERF-COST-SCORECARD.md:14`** — "`TranscriptV2` + virtualization (W13)."
    - **`docs/specs/SOTA-MARKET-READY-REPORT.md:40`** — "W13 | GREEN | `TranscriptV2`."
    - **`docs/specs/GA-COMPLETION-CHECKLIST.md:141`** — "N10 | DONE | ... `SpanSearchBar`
      save-as-signal."

    **Implication**: at least five separately-maintained `docs/specs/` documents independently
    assert the same nonexistent component names as shipped, including one literally named
    `CODEBASE-GROUND-TRUTH.md`. Likeliest explanation is a common (never-verified) source-of-truth
    claim rather than five independent fabrications — but regardless of cause, none of these five
    documents' "SHIPPED"/"DONE"/"GREEN" claims about portal component names should be trusted
    without an independent `grep` against `clients/portal/src`. Treat as a doc-wide reliability
    problem, not a single-file one.
27. **`docs/docs/how-to/mcp-cursor.md:149` instructs users to call the exact dead endpoint from
    item 21.** The doc reads: "MCP-scoped key from **Settings → MCP** (`POST
    /orgs/{org}/mcp/keys`)..." — but that route is never mounted (item 21) and the portal has no
    "Settings → MCP" UI that calls it (item 22's `createMcpKey` has zero UI callers). This is a
    public, user-facing how-to doc giving instructions that would 404 in production if followed
    exactly as written; a user would have to fall back to the doc's other documented option (an
    org-level API key, `EDEN_API_KEY`, per `:52`) to actually succeed. The page is already marked
    `sidebar_label: MCP in Cursor (retired)` and `draft: true` in frontmatter (`:3-5`) — so the
    page isn't presented as fully current — but the specific `/mcp/keys` instruction isn't
    caveated as broken, and the file has an active uncommitted working-tree change (a one-line
    frontmatter removal of `unlisted: true`, unrelated to this finding), confirming it's actively
    being edited — a good candidate for a real fix rather than an archival note.

## Minor / non-bugs found

- `src/eden/self_obs/heartbeats.py:17` and `src/eden/storage/postgres.py:480` both carry
  `# TODO(config): promote to Settings` — same TODO duplicated across two files, low severity.
- `src/eden/api/routes/billing.py:721-722` has an intentionally, correctly deprecated route
  (`@router.post("/webhook", deprecated=True)` with a docstring explaining the old path) — a good
  example of the *correct* way to mark deprecation, worth citing as the pattern items 17/24's
  fully-dead-but-`@deprecated`-labeled code should have followed through on (removal), and as the
  contrast case for why items 17/24 are flagged as "fully removable" rather than "still
  transitioning."
- Other "deprecated"/"XXX" hits (`metric_studio/registry.py`, `pii_intl.py`, `faker_vault.py`) are
  legitimate domain vocabulary (a metric lifecycle state, PII format placeholders), not bugs.

## Final verdict (pass 4)

All 27 numbered dead-code/stale-docs items in this doc were independently re-confirmed against
current source this pass, with exact file:line and caller-count matches — this is a
high-confidence doc; nothing in it was cut. Two corrections came out of this pass: (1) item 23's
`useUrlSearch` entry wrongly claimed a sibling export (`useUrlState`) was "real and used
elsewhere" — it is not; the entire `use-url-state.ts` file is dead, which strengthens rather than
weakens the item. (2) The `register_providers_from_env`/`AIGateway` note undercounted real
`AIGateway()` instantiation sites as two; there are three (the third a rare exception-fallback
path in `learn_wiring.py:49`), though this doesn't change the underlying conclusion that
production `_providers` stays empty. No dynamic-dispatch, registry, or alias-import path was found
that would resurrect any claimed-dead symbol (the one candidate that did have such a path,
`supervise`, was caught and correctly excluded before ever being reported — see Methodology). No
case was found where this doc mistakes a real, wired subsystem for dead code.
