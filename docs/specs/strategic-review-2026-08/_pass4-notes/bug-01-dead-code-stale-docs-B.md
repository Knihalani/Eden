# Pass 4 — Adversarial Check: bugs/01-dead-code-stale-docs.md (Agent B)

Independent re-verification, run fresh against the current working tree (not trusting the
doc's own "Round 3"/"Phase 2 Verdicts"/"Round 4" self-checks). Focus: (1) dynamic-dispatch/
registry paths that could resurrect a "dead" symbol, (2) whether any "stale doc" claim is
itself now stale, (3) redundancy against other bugs/ and optimizations/ files.

## ADVERSARIAL CHECK RESULTS

All spot-checked below independently, via fresh greps/git commands, not by reading the doc's
own verdict sections as ground truth.

**Dead-code claims re-verified (all held, no dynamic/registry path found that would resurrect
any of them):**
- `record_shadow_feedback` (`soft_issue_review.py:571`) — exactly 3 repo-wide hits (def, self-log
  L617, `__all__` L649), zero external callers. Confirmed.
- `run_investigator_llm_batch` (`signals/investigator.py:158`) — exactly 2 hits (def + test
  `patch()` target). Confirmed.
- `list_plan_tiers` / `get_feature_list` (`plan_tiers.py:281,286`) — 1 hit each (def only).
  Confirmed.
- `leader_session` (`workers/leader.py:25`) — checked every `from eden.workers.leader import`
  site repo-wide (30+ hits for the module); none touch `leader_session`, no `import ... as`
  aliasing. Confirmed dead — no alias-import escape hatch (the doc itself flags this exact
  failure mode for the `supervise` false-positive it caught and discarded; `leader_session` does
  not have the same escape).
- `_not_implemented_envelope` (metric_studio `_common.py:81`) — zero callers inside
  `src/eden/metric_studio/*.py`; only a test-file *comment* mentions the name
  (`tests/unit/test_session25_b14_b17.py:300`), not a call. Confirmed.
- `register_intelligence_judges` (`llmops/judges/builtin_v9.py:17`) — checked for any
  string-keyed judge-registry dispatch (`JUDGE_REGISTRY`, `judge_registry`) that might call it
  reflectively by name; none found. Only reference is the test that pins the no-op return value.
  Confirmed self-documented dead no-op.
- Portal hooks (`useOnline`, `useListKeyboardNav`, `useQueryTab`, `usePortalChromeEffects`,
  `useUrlSearch`, `useWorkspaceMode`, `useOrgMutation`, `useLiveTraceStream`) — checked for
  barrel/index re-export files under `clients/portal/src/hooks/` (none exist) and for
  string-based dynamic-import references (none). All 8 confirmed single-hit (own def line only).
- `portal-polish.ts` 13 dead constants — spot-checked 3 (`U20_CORE_AXE_ROUTES`,
  `WAVE12_LOOP_ROUTES`, `WAVE11_MOBILE_CARD_SURFACES`) — all single-hit. Confirmed.
- 8 more portal dead exports (`AbStatusChip`, `GuardrailsTabNav`, `GuardrailsTestView`,
  `SectionHead`, `NavToggle`, `MarketingPage`, `GRADE_LABELS`, `ROLE_LABELS`/`ROLE_COLORS`) — all
  confirmed single repo-wide hit via direct grep.
- Portal `@deprecated`-but-dead exports (`REMOVED_PORTAL_PATH_PREFIXES`, `STUB_CORE_SURFACE_IDS`,
  `FREE_TIER_PERSONAL_CAP_USD`, `FREE_TIER_ORG_CAP_USD`) — confirmed the exact `@deprecated`
  JSDoc annotations claimed, immediately above each export, e.g.
  `lib/constants.ts:27-30`: `/** @deprecated Use FREE_TIER_CAP_USD ... */`.

**`mcp_keys` router-unmounted claim (item 21) — independently reproduced from scratch, not
trusted from the doc's prose.** Wrote a standalone script parsing `src/eden/api/app.py`'s
`_DEFERRED_ROUTERS` tuple (96 entries), `_DEFERRED_INTELLIGENCE_ROUTERS` tuple (21 entries), and
the 7 immediate `app.include_router(...)` calls, then diffed the union against all 125
non-`__init__` files in `src/eden/api/routes/`. Result: **124/125 accounted for, `mcp_keys` is
the sole unaccounted file** — exact match to the doc's claim. Also checked for a dynamic
auto-mount mechanism that might catch `mcp_keys` another way: `src/eden/api/routes/__init__.py`
does have an `importlib`-based `__getattr__` (PEP 562), but it's a **lazy-import-on-attribute-
access** convenience only — it does not call `include_router()` or register anything with `app`.
No other `pkgutil`/`iter_modules` auto-registration exists anywhere under `src/eden/api/`.
`grep -rn mcp_keys` across `src/eden/api/app.py` returns zero hits. Confirmed: this router is
genuinely unreachable via HTTP in production.

**Stale-docs claims re-verified against current file content (exact line quotes):**
- `CODEBASE-GROUND-TRUTH.md:161` and `:182`, `SOTA-PERF-COST-SCORECARD.md:14`,
  `SOTA-MARKET-READY-REPORT.md:40`, `GA-COMPLETION-CHECKLIST.md:141` — all quoted text matches
  the current file content verbatim (re-grepped directly, not copy-checked from the report).
  `clients/portal/src/components/portal-os/` still does not exist; `BulkActionBar`/
  `SpanSearchBar` still zero matches in `clients/`.
- `OPTIMIZATION-ID-CHECKLIST.md:32-33` (K36/K37 "DONE") — confirmed unchanged, `sdk/go`/
  `sdk/rust` confirmed absent from working tree, `git status --porcelain` shows 30 `D ` entries
  (16 go + 14 rust) plus 2 CI workflow deletions — matches doc's count.
- `mcp-cursor.md` uncommitted diff — confirmed via `git diff`: the only unstaged change is
  removal of `unlisted: true` from frontmatter, unrelated to the `/mcp/keys` finding, exactly as
  the doc states.

**Is any "stale doc" claim itself now stale?** Yes, one:
- **`docs/specs/strategic-review-2026-08/_pass4-notes/sdk-deletion-verify.md`** (written by
  another agent in this same pass 4) independently re-confirms items 18-19 from scratch and
  explicitly cross-references this doc (`bugs/01-dead-code-stale-docs.md:302-311`) as already
  having flagged the same K36/K37 issue. Not a contradiction — just confirms items 18/19 are
  solid and now double-verified by an independent pass. No action needed, but worth noting for
  synthesis so it isn't re-litigated a third time.
- The `docs/specs/ui/overhaul-2026/*.md` planning docs (see NEW FINDINGS below) are NOT stale in
  the sense of "already fixed" — they still assert the fabricated `portal-os/` directory as of
  this check. So the doc's item 26 ("BulkActionBar fabrication... at least five documents") is
  itself an *understatement*, not stale — see below.

## CUT

- **None of the "Confirmed dead code" or "Stale-docs" items themselves warrant cutting** — every
  claim independently spot-checked (see above) reproduced exactly, including file:line precision
  and hit counts. This is an unusually well-verified doc.

- **CUT (downgrade to "superseded, no action needed"): the "⚠️ CRITICAL — scope warning for
  Phase 2 synthesis" section at the top of the file (lines 3-32).** This section is itself now
  stale as of pass 4. It warns that `F02`, `F03`, `F08`, `F12`, `F10`, `F05`, `F04`, `F11` "gap"
  claims must be re-checked against modules like `guardrails/`, `playground/`, `evaluation/`,
  `time_travel/` before the roadmap is finalized. Checking the actual current state of those
  feature docs: `docs/specs/strategic-review-2026-08/features/02-evals-datasets.md`,
  `03-prompt-playground.md`, `08-annotation-labeling.md`, and `12-runtime-guardrails.md` are all
  now dated "pass 3" (2026-08-05) and have already incorporated exactly this correction — e.g.
  F12's verdict opens with "The task premise ('eden is purely post-hoc, no inline intervention
  path') is confirmed **false** — eden has a mature, fail-closed, synchronous guardrails engine,"
  which is precisely the correction this warning demanded. `KNOWN-SUBSYSTEMS.md` (the review's
  ground-truth doc, explicitly cited as required reading before any gap claim) also already
  exists and covers this same ground in more depth. Recommend synthesis drop this section or
  replace it with a one-line "resolved — see KNOWN-SUBSYSTEMS.md and features/{02,03,08,12}.md
  pass-3 revisions" note; carrying it forward as an open warning in the final doc would mislead a
  reader into re-doing work that's already done.

- **CUT/consolidate for redundancy, not correctness: "Phase 2 Verdicts" (lines 330-411)
  duplicates "Round 3" (lines 193-230) almost item-for-item**, and "Round 3 summary"
  (413-428)/"Round 4 summary" (612-631) both re-recap findings already itemized in full above
  them. E.g. compare line 200 (`record_shadow_feedback — 3 hits total...`) against line 335-338
  (`record_shadow_feedback orphan — VERDICT: CONFIRMED REAL. ...exactly 3 hits...`) — same fact,
  same file:line, stated twice in adjacent sections. This is not wrong, just accumulated
  audit-trail bloat across passes that was never consolidated. For synthesis, one pass of
  "confirmed items with verdicts" is enough; the doc currently states each of items 1-19 fully
  three times (original finding → Round 3 re-verification → Phase 2 Verdicts) and items 20-27
  twice. Recommend synthesis keep one canonical list with file:line + hit-count, drop the
  repeated verdict/summary passes.

- **Quote: "Recommend a dedicated fork whose only job is auditing these ~15 unexplored top-level
  packages ... before finalizing INDEX.md."** (line 28-32) — CUT for the same staleness reason as
  above; this recommendation has already been carried out (`KNOWN-SUBSYSTEMS.md` plus the pass-3
  feature-doc revisions are exactly that audit).

## NEW FINDINGS

**1. The `BulkActionBar`/`portal-os` fabrication is far larger than item 26 states — it
originates from an entire planning-doc directory, not just "four other tracking docs."**

Item 26 says the fabrication "independently recurs in at least four other `docs/specs/`
tracking docs." A repo-wide grep for `BulkActionBar` under `docs/` turns up **at least 13
additional hit files beyond the ones item 26 already lists**, almost all under
`docs/specs/ui/overhaul-2026/`:
- `docs/specs/ui/overhaul-2026/w1-component-inventory.md:76` — this is the most concerning one.
  It's not just a passing mention; it's a full fabricated **inventory table** for a
  `components/portal-os/` barrel (section header `### \`portal-os/\` (barrel:
  \`components/portal-os/index.ts\`)`, lines ~63-82) cataloging **19 components** with
  prop-signature detail (`AppShell`, `ResourcePageShell`, `CoreResourcePage`,
  `useResourceUrlState`, `QueryFilterBar`, `ViewsMenu`, `ResourceOsToolbar`,
  `TableExportToolbar`, `BulkActionBar`, `CrossLinkBar`, `DriftHistogram`, `DetailPanelShell`,
  `InfiniteDataTable`, `VirtualizedList`, `CommandPalette`, `MobileBottomNav`,
  `DensityProvider`, plus fixture stubs), each given a specific file path like
  `portal-os/BulkActionBar.tsx`. The doc's own methodology line (`w1-component-inventory.md:6`)
  claims this was built via "export/API scan + named-import graph across `clients/portal/src`" —
  i.e. it self-describes as a factual code scan, not a design proposal. Directly verified:
  `find clients/portal/src -iname "*portal-os*"` returns **zero results** — the entire
  `components/portal-os/` directory this table describes does not exist anywhere in the repo.
- The same fabricated component set recurs (with page/line detail, sticky-bottom layout specs,
  prop contracts) across at least: `docs/specs/ui/overhaul-2026/w1-hub-surfaces.md:88,102`,
  `w1-consolidated-inventory.md` (per w3-p0-p3-backlog.md's own citation),
  `w2-laminar-contracts.md:108`, `w3-p0-p3-backlog.md:59,96`,
  `w3-laminar-acceptance.md:239`, `w3-hierarchy-spec.md:34,62,232`,
  `w3-component-contract.md:132`, `w3-industry-acceptance.md:327`,
  `w3-peer-acceptance.md:109,117`, `w6-verification-report.md:163`.
- This directory is genuinely still live (its most recent touching commit,
  `f2e04900 feat(portal): ship UI overhaul, cut load bloat, align marketing/docs`, is the only
  commit that has ever touched `w1-component-inventory.md`) — not previously-flagged stale
  content that's since been fixed.
- **Recommendation for synthesis**: item 26 should be reworded from "at least four other
  tracking docs" to something like "at least a dozen docs, including an entire
  `docs/specs/ui/overhaul-2026/` planning-doc series that self-describes as a factual
  export/API scan of a `components/portal-os/` directory that does not exist" — the
  `overhaul-2026/` series is very plausibly the *source* the other four trackers
  (`CODEBASE-GROUND-TRUTH.md` etc.) copied the fabricated names from, which is a more useful
  root-cause framing for Phase-2/whoever fixes this than "five independent fabrications."

**2. Adjacent, non-duplicate finding already on record elsewhere in this review — worth a
cross-reference, not a new bugs/ entry:** `docs/specs/strategic-review-2026-08/
PHASE2-router-wiring-audit.md:26` independently flags `llmops/model_comparator.py` as genuinely
orphaned dead code (imported by `api/routes/llmops.py`'s module but the class itself,
`ModelComparator`, has zero references anywhere outside its own file) — using the same
router-wiring-audit methodology that this doc's item 21 (`mcp_keys`) resolves. This is a real,
separate dead-code item, but it already lives in `PHASE2-router-wiring-audit.md`, not in
`bugs/01-dead-code-stale-docs.md` — flagging here only so synthesis doesn't lose it or
accidentally treat it as a duplicate of `mcp_keys` (different mechanism: `model_comparator.py`
is dead because nothing imports the *class*, not because a router is unmounted).

## Summary

This is the most heavily-scrutinized doc I've adversarially checked in this pass: every
dead-code claim (11 backend, 8 hooks, 13 constants, 8 more exports, 7 `@deprecated` exports) and
every stale-doc claim (`BulkActionBar`/`TranscriptV2`/`SpanSearchBar` fabrication, W20
router-mount reversal, SDK-deletion checklist staleness) reproduced exactly under independent
fresh greps/git commands/a from-scratch Python script for the router-mount math. No false
positives found, no dynamic-dispatch/registry/alias-import path found that would resurrect any
claimed-dead symbol. The only real issues are (a) internal redundancy — the doc re-states items
1-19 three times across "original," "Round 3," and "Phase 2 Verdicts" sections, and (b) the
top-of-file "CRITICAL scope warning" is now stale/superseded by `KNOWN-SUBSYSTEMS.md` and the
pass-3 feature-doc revisions and should be cut or downgraded for the final synthesis. One
finding was extended, not contradicted: the `BulkActionBar`/`portal-os` fabrication (item 26) is
substantially bigger than stated — it traces to an entire `docs/specs/ui/overhaul-2026/`
planning-doc series (13+ additional files) that self-describes as a factual code scan of a
directory that doesn't exist.
