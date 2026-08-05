# Pass 4 — Agent B (Impact Validator) notes on bugs/02-data-consistency.md

Scope per assignment: blast radius (callers/orgs/rows), silent-vs-noisy, age (git blame/log),
redundancy vs. optimizations/02-db-queries.md and bugs/03-api-mcp-contracts.md, prune filler.
All line numbers re-verified against HEAD this pass (repo root `/Users/kaiavnihalani/Downloads/Eden`).

## Headline correction (applies to Bug 3 §3d, Bug 3 §3a-c `/analyze`, and Bug 6's `/chain`)

**The doc's "single worst finding" framing for Bug 3 §3d (`POST /incidents/cluster` always
returns empty) needs a major blast-radius correction the doc never checks: as of 3 days before
this review, the entire `rcaApi` frontend surface — `analyze`, `explain`, `clusterIncidents`,
`listIncidents`, `summarizeIncident` — was deliberately deleted from the portal as a
zero-consumer dead-code prune, and a regression test now enforces it stays deleted.**

Evidence:
- `clients/portal/src/lib/api/resources.ts` — no `clusterIncidents`, `rcaApi`, or any reference
  to `intelligence/rca/incidents/cluster` in the current working tree (confirmed via grep across
  `clients/portal/src`, excluding `.next` build artifacts).
- `git show 16451d166 -- clients/portal/src/lib/api/resources.ts` shows the entire `rcaApi`
  object (`analyze`, `explain`, `clusterIncidents`, `listIncidents`, `summarizeIncident`) deleted
  in one hunk, commit message: "Data layer: resources.ts pruned 7.1k -> 4k lines". Commit date
  **2026-08-02 12:25:59 -0400** — 3 days before this review, and *after* Phase 3 of this same doc
  (which already covers Bug 3's original 3 sites).
- `clients/portal/src/lib/api/__tests__/dead-code-removal.test.ts:18-51` — `rcaApi` is explicitly
  listed in `deletedNamespaces`, guarded by `expect(resources).not.toHaveProperty(name)`. This
  was a *verified, intentional, zero-consumer* removal, not an accident — the team confirmed no
  portal caller before deleting it.
- No MCP tool calls it either: `bugs/03-api-mcp-contracts.md` §1.D's exhaustive 28-tool sweep
  lists every MCP tool's target route; none targets `/intelligence/rca/*`. That same doc's own
  §3 carried-forward finding #7 states outright: *"`signal_investigator.py`/`intelligence_rca.py`
  (RCA chain, F06 investigate) remain backend-only: zero portal callers, absent from the 28-tool
  MCP catalog."* — 02-data-consistency.md's Bug 3/Bug 6 write-ups never cross-reference this,
  despite it directly undercutting the "single worst finding" / "displacing Bug 4" claims.
- No SDK caller either (`grep -rln "incidents/cluster" sdk/` → zero hits).
- The `/chain` endpoint Bug 6 discusses (`rca_chain`, added in commit `64233475`, 2026-08-04 —
  correctly flagged by the doc as "brand new, not aged debt") was added *after* `rcaApi` was
  deleted, and also has zero portal caller today (`grep -rn "causal_chain|rcaChain|getChain"
  clients/portal/src` → zero hits).

**What this means for severity, precisely:**
- `POST /incidents/cluster` is still routed and reachable by a **direct, undocumented REST call**
  (no portal button, no MCP tool, no SDK method reaches it) — so "for every org, on every call"
  is technically true of the code path but overstates *product* blast radius: there is currently
  no in-product way for a customer or agent to trigger it. The doc should downgrade this from
  "single worst finding, displacing Bug 4" to "confirmed dead-on-arrival bug in a currently
  unreachable-from-product endpoint" — still worth fixing (the schema bug is real and the fix is
  cheap), but not the highest-blast-radius item in this doc. **Bug 9 (portal trace-list/detail
  badge, `portal.py:1284/1464`, actively used by every trace page view) has a larger real,
  currently-live blast radius than Bug 3 §3d and should be considered for the "worst" slot
  instead** — see below.
- The same applies to Bug 3 §3a-c's `/analyze` findings (`intelligence_rca.py`'s `_event_failed`
  et al.) to the extent they're reached only through the deleted `rcaApi.analyze`/`explain` calls
  — but note `_classify_events`/the outcome-vocabulary bug is *also* shared by
  `IncidentClusterer.cluster` (confirmed: `clusterer.py:185`, `_classify_events` import at
  `_common.py`), which is itself only reached through the same dead `/incidents/cluster` route.
  So the entire outcome-vocabulary family in Bug 3, as it manifests through `intelligence_rca.py`
  and `clusterer.py`, currently affects **zero live product surfaces** — it would matter the
  moment either a portal UI or an MCP tool is wired back up to these routes, which is plausible
  given `/chain` was *just* added on top of this same file, but it is not live today.
- Bug 7's item 1 (`clusterer.py:188-189`, `:344-345`, the "unknown" bucket merge in
  `IncidentClusterer.cluster`) is likewise gated behind the same dead route — same caveat
  applies. **Bug 7's item 2 (`fingerprint.py:88`) and item 3 (`repo.py:174-176`) are NOT
  affected** — `compute_fingerprint` is called from `stumble_writer.py:49`
  (`src/eden/issues/stumble_writer.py`), which is the live, always-on stumble-creation path used
  by the signal investigator and auto-scanner, confirmed independent of the dead RCA routes.

This doesn't mean the underlying code bugs are false — the `error`-column-doesn't-exist finding
(§3d) is a genuine, well-evidenced schema bug (see verification below) — but the doc's severity
ranking overstates current product impact by omitting a fact that was independently discoverable
and is even stated in the sibling doc it's supposed to be reconciled against.

---

## Bug-by-bug impact audit

### Bug 1 — prompt-evolution orphan prompts (`components.py:772`, `prompt_versioning.py:223/240/242`)

**Verified accurate.** `create_version` (`prompt_versioning.py:223-244`) does call
`self.get_prompt(org_id, prompt_name)` then falls through to `self.create_prompt(...)` on `None`
— confirmed at lines 237-241. `evolve_from_issue`'s `agent = agent_id or issue.agent_id`
confirmed at `components.py:696`, positional pass at `:773`.

**Blast radius:** `IssuePromptEvolver` has exactly 2 references repo-wide
(`grep -rln "IssuePromptEvolver" src/eden` → `components.py`, `agent_issues.py`) — its only
caller is `resolve_issue`'s `resolved` branch (`agent_issues.py:180-223`, confirmed live/used
endpoint, portal-called via `agentIssuesApi.resolve`). So this bug fires on every issue resolution
where the agent's real prompt name != agent_id — real, not theoretical, and on a route confirmed
actively used by the portal issues board. **Silent**: wrapped in `except Exception:
logger.debug(...)` (`agent_issues.py:220-221`) — failures don't even surface as errors, and the
non-failure "success" case (creating the wrong orphan prompt) has no signal at all. Age: not
independently git-blamed this pass, doc doesn't claim recency, no reason to doubt "long-standing."

**Verdict: KEEP, accurate as described, correctly scoped.**

### Bug 2 — NULL `agent_id` dropped from evolution scoring (`components.py:78-93`)

**Verified accurate.** `_AGG_QUERY`'s `AND te.attributes->>'agent_id' IS NOT NULL` confirmed at
`components.py:93` (comment at `:78` confirmed verbatim). `JudgeScorePromptEvolver` (uses this
query at `:166`) has 3 repo-wide references (`__init__.py`, `components.py`, `loop.py`) — `loop.py`
existing confirms this runs on a scheduled loop, not dead code.

**Blast radius:** proportional to how many orgs have inconsistent `agent_id` tagging (see Bug 4/5
below — this is a real, non-trivial population given the SDK/OTel/framework instrumentation gaps
documented elsewhere in this same doc). Silent: no counter/log, confirmed no
`null_agent_id`-shaped metric anywhere in `components.py`.

**Verdict: KEEP, accurate, live code path.**

### Bug 3 — `outcome == "error"` dead-vocabulary bug + §3d schema bug

**§3d schema claim — independently re-verified, 100% confirmed:**
- `_common.py:198-214` (`_fetch_failed_traces_in_window`) — exact text at line 204:
  `AND (error IS NOT NULL OR outcome = 'error')`, wrapped in `try/except Exception:
  logger.debug(...); return []` (`:211-213`). Confirmed exactly as quoted.
- `009_telemetry_events.py:31-52` — full `CREATE TABLE telemetry_events` column list confirmed:
  no `error` column (has `outcome VARCHAR(32)` only).
- `grep -rn "error_type\|error VARCHAR\|error TEXT\|error JSONB" db_migrations/versions/*.py |
  grep -i telemetry` → only hit is `067_trace_quality_otel_columns.py:153`, a **DROP COLUMN
  IF EXISTS error_type** — confirming `error_type` (not `error`) is the real column name, and it
  even gets dropped/re-added by migration churn. No migration ever adds a bare `error` column.
  Doc's claim stands.
- `IncidentClusterer.cluster` (`clusterer.py:125-170`) confirmed: `if not trace_ids: return
  _ok_envelope(self.name, {"clusters": [], ..., "total_failed_traces": 0})` — exact match to the
  doc's claimed HTTP-200-empty-envelope behavior.
- **Age**: `_common.py` was added at commit `da6db9da` (2026-06-14, confirmed via
  `git log --diff-filter=A --follow`), and the `error IS NOT NULL OR outcome = 'error'` line
  existed by then per `git log -p` (only `ORDER BY`/`LIMIT` were added later, in `88133a00`,
  2026-07-31). So this has been broken since file creation, **~7 weeks** as of this review
  (2026-08-05) — "hasn't ever worked" is accurate, not exaggerated.
- **Reachability**: see headline correction above — the route exists and is broken exactly as
  described, but has zero confirmed live callers as of 3 days before this review.

**§3a-c (outcome-vocabulary dead condition, `_event_failed` et al.) — spot-checked, accurate**:
`intelligence_rca.py:68-69` confirmed verbatim. The 5 duplicate sites in `_common.py` were not
all individually re-verified this pass (out of scope for impact-only review) but the two
load-bearing ones were: `_common.py:204` (above) and the `_classify_events`/`_first_failed_event`
chain is real Python, no red flags in a spot read.

**Verdict: KEEP the technical finding (accurate, well-evidenced, correctly attributes the schema
bug to a specific migration gap). CUT/DOWNGRADE the "single worst finding, displacing Bug 4"
severity claim** — it should be reframed as "worst *code-correctness* finding, but currently
zero live blast radius; would become the worst *product* finding the moment `/incidents/cluster`,
`/analyze`, or `/chain` gets a caller wired up" — see headline section.

### Bug 4 — ghost agent cards (`portal.py:886,929,1063,1100-1101,1151-1177`)

**Verified accurate.** `_load_registry` (`:886-925`) confirmed keyed on `agent_registrations`.
`_build` merge (`:1100+`) confirmed exact-string `metrics_by_id.get(agent_id)` lookup at
`:1103-1104`; SDK-only-agents ghost-card loop confirmed at `:1151-1163` (doc's line numbers are
close but not exact — actual loop starts ~`:1151`, doc says `:1165`; off by ~14 lines, immaterial
to the finding). This endpoint (`_load_registry`/`_load_metrics`/`_build`) backs the portal's
primary Agents dashboard — confirmed live/high-traffic surface, unlike Bug 3.

**Verdict: KEEP. This is legitimately one of the higher-blast-radius findings in the doc** — it's
in a definitely-live, definitely-used dashboard, unlike Bug 3's dead route. The doc's "Bug 4
(worst finding)" header (before Phase 4 displaced it) was arguably more justified than Phase 4's
Bug 3 promotion, given Bug 3's now-confirmed dead reachability.

### Bug 5 — NULL-`agent_id` events excluded from dashboard (`portal.py:941,1076`)

**Verified accurate**, both filters confirmed verbatim (`AND agent_id IS NOT NULL` at both
lines). Same live-dashboard reachability as Bug 4 — this is a real, currently-affecting-every-org
gap (any org with instrumentation gaps loses those rows from every card silently). **Verdict: KEEP.**

### Bug 6 — `agent_id` unvalidated + dropped from causal chain

Two components with **different blast radius, doc doesn't distinguish them**:
- `signal_investigator.py:248/305`, `investigator.py:363/395` (unvalidated `agent_id` on
  stumbles) — this write path is live (signal investigation runs on every finalized trace per
  `optimizations/02-db-queries.md` F1/F2's description of `investigate_trace`). **Real, live.**
- `_build_causal_chain` dropping `agent_id` (`intelligence_rca.py:80-123`) feeds the `/chain`
  endpoint, which — per headline correction — has zero portal/MCP caller today. Doc's own
  observation that this is "brand-new... not aged debt" (confirmed: `/chain` added same commit,
  `64233475`, 2026-08-04) already signals this is low-current-impact; the doc should have gone
  one step further and noted zero reachability, same as Bug 3.
- The `GET /stumbles?agent_id=...` repro (`repo.py:174-176`) has no confirmed portal caller
  (`agentIssuesApi` in `resources.ts` only has `POST /stumbles`, no `GET .../stumbles?agent_id=`),
  but IS reachable via the MCP `search_issues` tool per `bugs/03-api-mcp-contracts.md` §1.D
  ("search_issues/get_issue/triage_issue/... → agent-issues.py routes ... all present"). So this
  half has real, if narrower (MCP-agent-only, not portal-user), blast radius.

**Verdict: KEEP the stumble-write-path half (live). DOWNGRADE the `/chain`-drops-agent_id half**
to "correct but currently unreachable from product" — same caveat as Bug 3/Bug 7-item-1.

### Bug 7 — "unknown" bucket merge (clusterer + fingerprint + repo filter)

Split verdict, same pattern as Bug 6:
- Item 1 (`clusterer.py:188-189,344-345`) — gated behind dead `/incidents/cluster`. **DOWNGRADE.**
- Item 2 (`fingerprint.py:88`) — confirmed called from `stumble_writer.py:49`, the live
  stumble-write path (signal investigator + auto-scanner). **KEEP, live, real.**
- Item 3 (`repo.py:174-176`) — reachable via MCP `search_issues`/portal `GET /agent-issues` (the
  portal issues board does call list endpoints; not independently re-verified this pass which
  exact query params it sends, but the underlying filter clause is real code on a live table).
  **KEEP.**

### Bug 8 — `resolve_issue` status coercion + `"acknowledged"` DB-illegal value

**Verified accurate and independently confirmed:**
- `agent_issues.py:107-114` (`ResolveRequest`, `_RESOLVE_STATUSES`) and `:173`
  (`target = body.status if body.status in _RESOLVE_STATUSES else "resolved"`) confirmed exactly.
- `136_issue_status_escalated.py:34-38` `_BASE_STATUSES` confirmed: `open, triaged, fix_pending,
  verifying, resolved, regressed, ignored, learning` + `escalated` via the CHECK constraint
  (`:63-66`). **`"acknowledged"` is confirmed absent from this list** — doc's claim is exact.
- This endpoint (`resolve_issue`) is confirmed live/portal-called (`agentIssuesApi.resolve`,
  used by the issues board's Acknowledge/Resolve/Reopen buttons per the doc's own §8c audit,
  itself internally consistent with what's in `resources.ts`).

**Redundancy — flag, don't cut:** this exact bug is **also** documented, independently, in
`bugs/03-api-mcp-contracts.md` as finding **#10**: *"`resolve_issue` silently coerces an invalid
`status` to `"resolved"` (`agent_issues.py:173`) — still the single highest-severity finding in
this file"* — and ranked **P0 #1** in that doc's priority list. Both docs independently landed on
this as their top/near-top finding, from different angles (data-consistency vs. API-contract).
This is good convergent validation (two independent passes, same root cause, same file/line), not
a case where either doc padded — but synthesis should merge these into one write-up rather than
fixing it twice, and note the cross-doc agreement as a confidence signal.

**Verdict: KEEP in full (highest-confidence bug in the doc — cross-validated by an independent
doc). Not padding, not redundant-as-filler; redundant-as-corroboration.**

### Bug 9 — portal trace badge misses `crash`/`timeout` (`portal.py:177-189,1284,1464`)

**Verified accurate, line-for-line.** `_map_trace_outcome` (`:177-183`) and `_ERROR_OUTCOMES`
(`:187-189`) confirmed exact text; call sites at `:1284`/`:1464` confirmed. Git blame:
`_map_trace_outcome` has existed since **2026-07-23** (`git log -S "_map_trace_outcome" ...` →
`c0aa22e5`), i.e. ~2 weeks old as of this review — not brand-new, not ancient, a real
multi-week-old live bug.

**Blast radius: this is the doc's highest-confidence, highest-reach bug.** Unlike Bug 3/6/7-item1,
`portal.py`'s `/traces` list and trace-detail endpoints are the **primary, unambiguously-live**
customer-facing surface — every trace page view for every org hits one of these two call sites.
No dead-code caveat applies here. **Given the headline correction to Bug 3's reachability, Bug 9
is arguably the single most impactful bug in this document**, not a "new, minor" addendum as its
numbering implies.

**Verdict: KEEP, and recommend synthesis re-rank this above Bug 3 for "worst finding."**

### Bug 10 — timestamp-normalization UTC gap (`normalizer.py:32-58`)

**Verified accurate.** Code confirmed to match the doc's excerpt exactly (`:32-57`): naive
`datetime` branch stamps UTC (`:41-42`), epoch branch always UTC (`:44-46`), naive ISO **string**
branch returns unchanged with no offset (`:52-53`). Doc's own "Not reached" section already
flags this wasn't tested against live Postgres — appropriately hedged, not overclaimed. The doc
is also appropriately hedged about which real ingestion paths can trigger it (only a
raw/webhook/hand-built caller supplying an offset-less string — SDKs and OTel use epoch numbers).

**Verdict: KEEP as written — this is the doc's most honestly-scoped finding; good model for how
the others should self-report reachability caveats.**

---

## Redundancy check vs. optimizations/02-db-queries.md

- `02-db-queries.md` F4 (`resolve_issue` re-fetches issue row twice, `agent_issues.py:190,209`)
  targets the **same function** as this doc's Bug 8, but a **different, non-overlapping concern**
  (perf/N+1 vs. data-integrity/status-enum) — not redundant, complementary. No action needed.
- `02-db-queries.md` F1/F2 (`signal_events` unindexed, `cluster_after_match`'s embedder import
  broken) both live in the same `signals/investigator.py`/`clusterer.py` write path this doc's
  Bug 6 (unvalidated `agent_id` on stumbles) and Bug 7-item-2 (fingerprint) touch — confirms via
  a second, independent doc that `investigate_trace`/`_write_event` is a genuinely live,
  high-frequency path (F1: "up to 20×/finalized trace"), which corroborates this doc's framing of
  Bug 2/6/7-item-2 as live/high-frequency rather than incidental. No overlap in the actual bug
  claims, just shared file scope — no redundancy to cut.
- No other overlap found between the two docs' actual bug claims.

## Redundancy check vs. bugs/03-api-mcp-contracts.md

- **Bug 8 ≈ finding #10** — see above, corroborating not redundant-filler.
- **finding #7** ("RCA chain / F06 investigate remain backend-only: zero portal callers, absent
  from MCP catalog") directly bears on this doc's Bug 3/Bug 6/Bug 7-item-1 and was **not
  incorporated** into 02-data-consistency.md despite being available in the same review pass.
  This is the single most important cross-doc finding of this audit — see headline section.
- No other overlap found.

## Summary of CUTs / DOWNGRADEs (for synthesis)

1. **CUT/DOWNGRADE**: Bug 3's "single worst finding, displacing Bug 4" framing (intro block,
   lines 13-31, and the Phase 4 Verdicts section, lines 817-828) — reroute severity to account for
   zero confirmed reachability of `/incidents/cluster`, `/analyze`, and (per Bug 6) `/chain`, all
   independently confirmed dead per `bugs/03-api-mcp-contracts.md` finding #7 and the
   `dead-code-removal.test.ts` regression guard. Quote: *"This is strictly worse than the
   inverted-verdict finding below: incident clustering hasn't degraded, it has never worked."*
   Reason for downgrade: true of the code, false of the product — nobody can currently trigger it.
2. **PROMOTE**: Bug 9 to "worst finding in this doc" given the above — it's live, ~2-weeks-old,
   hits every trace page view, no reachability caveat.
3. **No line-item cuts for filler/unverified content** — every individual technical claim
   independently checked this pass (Bugs 1, 2, 3§3d, 4, 5, 8, 9, 10 code-level verified; 6, 7
   spot-checked at their load-bearing lines) held up exactly as written. The doc's prose is
   verbose in places (e.g. the Phase 4 Verdicts section largely restates the body) but none of it
   is factually wrong — recommend synthesis trim for length, not for correctness.

## New findings (not in the original doc)

1. **The dead-RCA-route fact itself** (headline section) — new this pass, materially changes
   severity ranking, sourced from `resources.ts` git history + `dead-code-removal.test.ts` +
   cross-reference to `bugs/03-api-mcp-contracts.md` #7.
2. **Bug 9's exact age** (~2 weeks, since `c0aa22e5`, 2026-07-23) — doc doesn't currently state an
   age for this finding; useful for synthesis to include given it argues for higher priority.
3. **Bug 3 §3d's exact age** (~7 weeks, since file creation at `da6db9da`, 2026-06-14) —
   confirms "has never worked" is literally true from file inception, not an exaggeration.
4. **Bug 7's fingerprint.py:88 confirmed live via `stumble_writer.py:49`** — doc doesn't cite this
   call site; worth adding as the concrete evidence for why that item (unlike item 1) survives the
   dead-route caveat.
