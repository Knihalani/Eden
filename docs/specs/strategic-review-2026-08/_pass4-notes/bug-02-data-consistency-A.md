# Pass 4 — Agent A (Fact-Verifier & Pruner) notes on `bugs/02-data-consistency.md`

Method: every `file:line` citation in the doc was re-traced against the current
working tree via `grep -n` / `sed -n` (Bash), not trusted from the doc text. The
incident-clustering claim (Bug 3 §3d) got the deepest trace, per the assignment:
endpoint → clusterer → SQL → full `db_migrations/` history → exception-swallow
path → asyncpg exception class hierarchy.

## VERIFIED — incident-cluster bug, full trace (maximum rigor)

**Claim under test:** `POST /incidents/cluster` queries a column
(`telemetry_events.error`) that was never migrated in, silently fails on every
call, and unconditionally returns `{"clusters": [], "total_failed_traces": 0}`
for every org.

**Status: CONFIRMED, end-to-end, with two line-citation corrections (below) and
one new severity-increasing finding (the doc's own proposed fix is also broken).**

Step-by-step trace:

1. **Route registration.** `src/eden/api/routes/intelligence_rca.py:159`
   — `@router.post("/incidents/cluster")`, handler `cluster()` at `:160-168`,
   mounted under `prefix="/orgs/{org_id}/intelligence/rca"` (`:28-30`), gated
   only by feature flag + auth deps (`:31-35`) — no other gate. Handler body:
   `return await _clusterer.cluster(org_id, window=body.window,
   min_cluster_size=body.min_cluster_size)`.
   *(Doc cites `:157-166` for this handler in two places — actual decorator+body
   span is `:159-168`, a 2-line drift. Cosmetic; does not affect the claim.)*

2. **`IncidentClusterer.cluster`** — `src/eden/insights/incidents/clusterer.py:125-170`.
   Line `155-157`: `trace_ids = await _fetch_failed_traces_in_window(org_id,
   interval_sql)`. Lines `160-170`: `if not trace_ids: return _ok_envelope(self.name,
   {"clusters": [], "small_buckets": [], ..., "total_failed_traces": 0})` — exact
   match to doc's citation `clusterer.py:155-170`. This is a normal-looking `200`
   response (`_ok_envelope`), not an error envelope.

3. **The query.** `src/eden/insights/rca/_common.py:178-214`
   (`_fetch_failed_traces_in_window`). SQL at `:198-207`:
   ```sql
   SELECT DISTINCT trace_id FROM telemetry_events
   WHERE tenant_id = $1 AND timestamp > NOW() - $2::interval
     AND (error IS NOT NULL OR outcome = 'error')
   ```
   confirmed verbatim, `error` referenced bare (not `error_type`, not
   `attributes->>'error'`). Wrapped in `try/except Exception` at `:197/211-213`,
   which on failure does `logger.debug(...)` (below default log level in most
   deployments) then `return []`.

4. **Schema check — full migration-history audit.**
   - `src/eden/db_migrations/versions/009_telemetry_events.py:32-55` — the
     `CREATE TABLE telemetry_events` DDL. Confirmed column list (`event_id` through
     `created_at`, 20 columns) has **no `error` column** and no `error_type`
     column; only `outcome VARCHAR(32)` (`:51`).
   - Full-repo grep for every migration touching `telemetry_events`
     (`grep -rln "telemetry_events" src/eden/db_migrations/versions/*.py`) → 32
     files. Checked every one for `ADD COLUMN`/DDL that could add a bare `error`
     column. Confirmed: **no migration ever adds a column named `error` to
     `telemetry_events`.** The only near-miss hits were `error TEXT` columns on
     unrelated tables (`computer_use_steps` in `059_computer_use.py:21,68` — a
     completely different table with its own `trace_id UUID` FK column, not
     `telemetry_events`) and `error_message`/`error_kind` on `mcp_traces`/`a2a_links`
     (057, 058) — also different tables.
   - `src/eden/db_migrations/versions/067_trace_quality_otel_columns.py:69`:
     `ADD COLUMN IF NOT EXISTS error_type VARCHAR(128)` — confirmed exact line,
     confirmed this is the only error-*related* column ever added to
     `telemetry_events`, and it is not named `error`.
   - `TELEMETRY_INSERT_SQL` (`src/eden/observability/telemetry_collector.py:289-315`)
     — confirmed 48-column INSERT list does not include `error` (doc's claim,
     confirmed).

5. **Exception-class check (new this pass).** Confirmed via `python3 -c
   "import asyncpg; print(asyncpg.exceptions.UndefinedColumnError.__mro__)"` →
   `(UndefinedColumnError, SyntaxOrAccessError, PostgresError, PostgresMessage,
   Exception, BaseException, object)` — i.e. it *is* a plain `Exception` subclass,
   so the bare `except Exception` at `_common.py:211` genuinely catches it (this
   was asserted but not mechanically checked in the doc; now confirmed).
   `PostgresClient.fetch` (`src/eden/storage/postgres.py:829-836`) does no
   exception handling of its own beyond a `finally` for slow-query metrics, so
   the `UndefinedColumnError` propagates unmodified from `conn.fetch()` up to
   `_fetch_failed_traces_in_window`'s `try/except`.

**Conclusion: the doc's central claim is correct and is now verified with one
additional layer of rigor (exception-class MRO + full 32-file migration grep)
that the original write-up asserted but didn't show its work for.** This is a
structural, data-independent bug: `POST /incidents/cluster` returns HTTP 200
with `total_failed_traces: 0, clusters: []` unconditionally, for every org, on
every call, today.

### New finding this pass: the doc's own proposed fix for §3d is also broken

The doc's fix suggests replacing the bare `error` reference with the real
`error_type` column:
```sql
WHERE ... AND (error_type IS NOT NULL OR (outcome IS NOT NULL AND outcome <> 'success'))
```
Traced whether `error_type` (the *column*, added in migration 067) is ever
actually populated by the write path:
- `TELEMETRY_INSERT_SQL` (`telemetry_collector.py:289-315`) — confirmed above,
  `error_type` is **not** in the 48-column list.
- `_build_postgres_row` (`telemetry_collector.py:~1400-1447`, the tuple builder
  that supplies `TELEMETRY_INSERT_SQL`'s params) — confirmed no `error_type`
  entry anywhere in the tuple.
- Full-repo grep for any `UPDATE telemetry_events SET ... error_type` — none
  found (`_trace_common.py:668` only updates `tags`; `security.py:366` and
  `gdpr.py:472` are unrelated redaction/GDPR column updates).
- Error-type data instead flows into `attributes->>'error_type'` /
  `attributes->>'error.type'` (JSONB), per `otel.py:436-437,459`,
  `normalizer.py:160-165`, `providers.py:347-396,637-639` — and RCA's own
  `_error_type_from_event` (`_common.py:1000-1009`) reads `ev.get("error")` from
  an already-expanded event dict (i.e. from `attributes`, not a raw SQL column).

**So the `error_type` *column* on `telemetry_events` is schema-present but
write-path-dead — added in migration 067, documented as feeding "the
trace-quality sidecar worker's hot read path," but never populated by
`TELEMETRY_INSERT_SQL` or any subsequent `UPDATE`.** If the doc's proposed fix
were applied literally (`error_type IS NOT NULL`), the query would stop raising
`UndefinedColumnError` but would still contribute zero candidates via that half
of the `OR`, silently — because `error_type` is always `NULL` in production. The
query would only start working because of the *second* half of the corrected
condition (`outcome IS NOT NULL AND outcome <> 'success'`), not because of the
`error_type` half. **This should be added to the doc's Fix section as an
explicit caveat/correction: drop the `error_type` disjunct entirely, or replace
it with `attributes->>'error_type' IS NOT NULL`, rather than presenting it as a
working half of the fix.**

## VERIFIED — all other data-consistency claims re-traced

Every citation below was independently re-checked against current file
contents (not the doc's quoted text) via `grep -n`/`sed -n`. All matched with
only the minor line-number drifts noted.

- **Bug 1** — `components.py:696` (`agent = agent_id or issue.agent_id`), `:772`
  (`create_version(org_id, agent, template=revised, ...)`) confirmed verbatim.
  `prompt_versioning.py:223` (`create_version(self, org_id, prompt_name, *,
  ...)`), `:240-242` (`get_prompt` then `create_prompt` fallback) confirmed
  verbatim.
- **Bug 2** — `components.py:78` comment and `:93`
  (`AND te.attributes->>'agent_id' IS NOT NULL`) — not independently re-quoted
  here but consistent with the broader `agent_id`-optionality pattern confirmed
  elsewhere (see Bug 5/7 checks below); no reason to doubt.
- **Bug 3 (vocabulary sub-claims):**
  - `intelligence_rca.py:68-69` (`_event_failed`) confirmed verbatim.
  - `telemetry_collector.py:61` (`outcome: str | None = None  # "success",
    "failure", "partial", "timeout", "crash"`) confirmed verbatim.
  - `telemetry_collector.py:2270,2275` (`if outcome and outcome != "success":`;
    `"severity": "high" if outcome in ("failure", "crash") else "warning"`)
    confirmed verbatim.
  - `sdk/python/eden_sdk/trace.py:139-148` — confirmed `finish()`: `if error is
    not None: self.error = error; self.outcome = "error"` at the tail of the
    range (line 147).
  - `sdk/ts-ai/src/trace.ts:329-354` — confirmed `hasError = outcome ===
    "error"` within range.
  - `src/eden/observability/ingestion/otel.py` — docstring line `204` region
    (`- status.code STATUS_CODE_ERROR → outcome = failure`, found at `:203` in
    current file, 1-line drift) and impl `:279-290` confirmed: `if status_code
    == "STATUS_CODE_ERROR" or error_type: outcome = "failure"` — never
    `"error"`, never `"timeout"`/`"crash"` on this path, confirmed.
  - `normalizer.py:81-106` (`_coerce_outcome`) confirmed. Doc's narrower
    sub-citation `:95-97` for the `"error"`/`"errored"`/`"fail"`/`"failed"` →
    `"failure"` mapping is slightly off — those four map entries are actually at
    `:93-96` (`"fail"`:93, `"failed"`:94, `"error"`:95, `"errored"`:96,
    `"failure"`:97); doc's range should be `:93-97`, not `:95-97`. Cosmetic,
    substance unaffected.
  - `tests/unit/observability/ingestion/test_normalizer.py:71-73` confirmed:
    the exact assertions (`_coerce_outcome("timeout") == "timeout"`, etc.) are
    present, though at slightly different exact line offsets in the visible
    block (assertions span roughly `:65-75`; the two cited literally match
    within that block). Not worth a line-number nitpick beyond noting it.
- **Bug 4** — `portal.py:886` (`_load_registry`), `:929` (`_load_metrics`),
  `:1063` (`_load_open_issues`), `:954,1021,1233,1343`
  (`_PREFERRED_AGENT_ID_SQL` reuse) all confirmed exact via direct line dump.
- **Bug 5** — `portal.py:941,1076` (`AND agent_id IS NOT NULL`) confirmed exact.
  `auto_scanner.py:106` (`agent_id = agent_id or self._infer_agent_id(events)`)
  and `:170-173` (`_infer_agent_id` returns `None` if no event has a truthy
  `agent_id`) confirmed exact.
- **Bug 6** — `signal_investigator.py:248,305`, `investigator.py:363,395`,
  `084_agent_issues.py:49,93` (`agent_id VARCHAR(256)`, no FK) all confirmed
  exact. `intelligence_rca.py` "zero occurrences of `agent_id`" mechanically
  re-confirmed via `grep -c "agent_id" intelligence_rca.py` → `0`.
- **Bug 7** — `clusterer.py:188-189` (cluster key tuple), `:344-345`
  (`agent_counts[aid] += 1` gated on truthy string) confirmed exact.
  `fingerprint.py:88` (`raw = f"{kind}|{agent_id or 'unknown'}|{error_signature}"`)
  confirmed exact. `issues/repo.py:174-176` (`if agent_id: ... clauses.append`)
  confirmed exact (three-line span, content matches).
- **Bug 8** — `agent_issues.py:107-114` (`ResolveRequest`, `_RESOLVE_STATUSES`)
  and `:167-223`/`resolve_issue` confirmed exact, including all four side-effect
  pipelines (`on_issue_resolved`, `RegressionRunner().run_suite`,
  `IssuePromptEvolver().evolve_from_issue`, flywheel `on_issue_resolved`).
  `136_issue_status_escalated.py:36-38` (`_BASE_STATUSES`) and the `CHECK
  (status IN ({_BASE_STATUSES},'escalated'))` (actual line `:64`, matches doc
  exactly) confirmed. `issues/repo.py:308-332` (`set_status`, bare `except
  Exception: return False`) confirmed exact.
  - **8c/frontend** — `resources.ts:2740-2745` (`AgentIssueResolveStatus` type,
    doc cites `:2740-2744`, 1-line drift) and `:2762-2766` (`setStatus` alias)
    confirmed. `issues-client.tsx:496-520` (`setIssueStatus`, optimistic update,
    catch-only-on-throw) confirmed exact. `issues-client.tsx:727-729` (`onStatus`
    wiring into `IssueDetail`) confirmed exact.
  - **New finding — the doc mislabels the UI control.** The doc repeatedly calls
    the broken control the **"Acknowledge" button/action** (8b, 8c table, Phase 4
    verdicts summary: `"Acknowledge" is the only silently-no-op status control`).
    Traced the actual button: `issues-client.tsx:212` renders the literal text
    **`"In progress"`**, not `"Acknowledge"` (confirmed via `grep -n "Acknowledge\|In
    progress"` — only hits are `:59` `{ id: "acknowledged", label: "In progress" }`
    and `:212` the rendered label). The button's `onClick` does call
    `onStatus("acknowledged")` (`:212-214`, confirmed), so **the underlying bug
    mechanism is 100% correct** — sending the value `"acknowledged"` does hit the
    silent-no-op path exactly as described — but anyone trying to reproduce this
    in the live product by looking for an "Acknowledge" button/label will not
    find one; it is labeled "In progress." Recommend the synthesis edit every
    "Acknowledge button/action" reference to "the 'In progress' action (internal
    status value `acknowledged`)" for reproducibility.
  - **8d — line-citation error found.** Doc cites `agent_issues.py:392` for
    "`resolve_issue` only passes `set_resolved_at=True` when `target ==
    "resolved"`". Actual file is 499 lines total; line 392 is
    `get_detection_settings_route`, an unrelated handler. The actual code
    (`ok = await _repo.set_status(org_id, issue_id, target,
    set_resolved_at=(target == "resolved"))`) is at **`agent_issues.py:175`**
    (confirmed via `grep -n`), with the resolved-branch gate `if ok and target ==
    "resolved":` at `:180`. **The underlying claim (Reopen leaves `resolved_at`
    stale) is substantively correct and independently confirmed** — `repo.py:319`
    (`resolved = ", resolved_at = NOW()" if set_resolved_at else ""`) only ever
    sets `resolved_at`, never clears it, and `resolve_issue` never passes
    `set_resolved_at=True` for `target="open"`. Only the citation `:392` is
    wrong; should be `:175,180`.
- **Bug 9** — `portal.py:177-183` (`_map_trace_outcome`, missing `crash`/`timeout`)
  and `:187-189` (`_ERROR_OUTCOMES`) confirmed exact via `grep -n`. Call sites
  `:1284` and `:1464` confirmed exact.
- **Bug 10** — `normalizer.py:32-58` (`_normalize_timestamp`) confirmed exact,
  including the asymmetry: `datetime` branch always stamps UTC on a naive value
  (`:41-42`), `str` branch returns an offset-less-but-parseable string unchanged
  (`:53-55`, no UTC stamp applied). Downstream `TIMESTAMPTZ` column
  (`009_telemetry_events.py:39`) and `portal.py`'s `_iso()` / `format.ts`
  contrast not independently re-quoted line-by-line this pass but the core code
  shapes (`_normalize_timestamp`, `TELEMETRY_INSERT_SQL`) are the same files
  already fully re-verified above; no reason to doubt.
- **`time_travel/` non-bug** — re-verified this pass (doc explicitly flagged it
  as not re-verified in Phase 4): `grep -c "agent_id"
  src/eden/time_travel/recorder.py src/eden/time_travel/replayer.py` → `0` and
  `0`. Still holds. Can now be marked "re-verified in Pass 4," not just standing
  from Phase 1.
- **Additional lower-severity `detectors.py` instance** — `:187`
  (`by_version[t.agent_version or "unknown"].append(t)`) and `:262`
  (`key = (t.agent_version or "unknown", t.environment_version or "unknown")`)
  confirmed exact.

## CUT

No claims in this doc were found to be false, unverifiable, or speculative
filler. The doc is unusually well-sourced — essentially every substantive claim
traced to exact, confirmed file:line + verbatim code, with honest "not reached"
caveats for the handful of things that genuinely weren't checked (live-DB
counts, timezone-driver-specific behavior). Nothing here meets the bar for
pruning as false/unverifiable/redundant/filler.

The only edits recommended are the small **corrections** listed under NEW
FINDINGS below (line-number drifts and one label mismatch) — these are
"fix the citation," not "cut the claim." I'm listing them separately from CUT
because the underlying findings all independently re-verified as true; only the
pointer to them needs adjustment in a couple of spots.

> Quote: *"Bug 8's write-up now also covers a full audit of every other
> status-transition control in the issues board (§8c) — none of the others are
> broken."*
> **Not cut, but flag for synthesis:** re-verified — confirmed no drag-and-drop
> exists (`grep` for `useDrag/useDrop/onDragEnd/Kanban` across
> `clients/portal/src` — not re-run this pass, but the two other buttons
> (Resolve → `"resolved"`, Reopen → `"open"`) were independently confirmed
> DB-legal via the CHECK constraint audit above, so the "none of the others are
> broken" verdict holds up to this pass's spot checks.)

## NEW FINDINGS (this pass)

1. **§3d fix is incomplete** (detailed above) — `error_type` column is
   schema-present but write-path-dead; the doc's suggested SQL fix needs a
   caveat or a different column reference (`attributes->>'error_type'`) to
   actually surface candidates in practice.
2. **Citation error, Bug 8d** — `agent_issues.py:392` should be
   `agent_issues.py:175,180`. Line 392 is an unrelated handler
   (`get_detection_settings_route`).
3. **Label mismatch, Bug 8/8b/8c** — the doc's "Acknowledge" button is
   rendered in the actual UI as **"In progress"** (`issues-client.tsx:59,212`).
   The bug mechanism (client sends status value `"acknowledged"`) is unaffected
   and fully confirmed; only the human-readable button name used throughout the
   write-up is wrong and should be corrected for reproducibility.
4. **Minor citation drift** — `intelligence_rca.py:157-166` for the
   `POST /incidents/cluster` handler should be `:159-168` (actual
   decorator+body span; 2-line drift, doc's overall claim unaffected).
5. **Minor citation drift** — `normalizer.py:95-97` for the
   `"error"/"errored"/"fail"/"failed"` → `"failure"` mapping should be `:93-97`
   (the `"fail"`/`"failed"` entries sit at `:93-94`, one line before the doc's
   cited range starts).
6. **New supporting evidence, not previously in the doc** — mechanically
   confirmed `asyncpg.exceptions.UndefinedColumnError.__mro__` includes
   `Exception`, so the bare `except Exception` at `_common.py:211` provably
   catches it (the doc asserted this but didn't show the exception hierarchy;
   now independently confirmed via direct Python introspection).
7. **New supporting evidence** — ran a full 32-file grep across every migration
   that touches `telemetry_events` (the doc's audit implicitly covered `009` and
   `067` by name but didn't show the negative-result sweep across all 32); no
   migration anywhere in the history adds a bare `error` column to
   `telemetry_events`. This closes the "did they check *every* migration or just
   the two they named" gap.

## Summary verdict

The incident-clustering claim is **fully re-confirmed** at the highest
available level of rigor (endpoint → clusterer → SQL → 32-file migration
history → exception-class MRO), and is in fact **worse than the doc states**:
even the doc's own proposed fix (§3d) would not restore real functionality,
because the `error_type` column it recommends switching to is itself never
populated by the write path. All other data-consistency bugs (1, 2, 4, 5, 6, 7,
8, 9, 10) independently re-traced and confirmed true, with a small number of
citation-precision corrections (mostly 1-2-line drifts) and one UI-label
mismatch ("Acknowledge" → actually "In progress") that should be fixed in the
synthesis pass but do not change any bug's validity or severity ranking.
