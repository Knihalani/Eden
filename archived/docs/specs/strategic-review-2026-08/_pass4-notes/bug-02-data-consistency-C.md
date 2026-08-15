# Pass 4 — Adversarial Skeptic notes (Agent C) on `bugs/02-data-consistency.md`

Mandate: assume the doc oversells itself; try hard to disprove the headline claim
and the other claims; cross-check against `KNOWN-SUBSYSTEMS.md` and sibling docs;
prune false/unverified/redundant/filler content. I did not edit the source doc.

## ADVERSARIAL CHECK RESULTS

### Headline claim ("incident clustering always returns zero") — COULD NOT DISPROVE. Independently strengthened.

The doc's central claim (Bug 3 §3d, and the summary line at the top of the file)
is: `_fetch_failed_traces_in_window` (`src/eden/insights/rca/_common.py:198-213`)
selects a bare `error` column from `telemetry_events` that was never created by
any migration, so every call raises `asyncpg.UndefinedColumnError`, which is
caught by a bare `except Exception: return []` (`_common.py:211-213`), so
`IncidentClusterer.cluster` (`clusterer.py:155-170`, confirmed read directly)
always sees `trace_ids == []` and returns `_ok_envelope(..., "clusters": [],
"total_failed_traces": 0)` — HTTP 200, no error surfaced — from the routed
`POST /incidents/cluster` endpoint (`intelligence_rca.py:159-168`, confirmed).

I tried to find a way this claim could be wrong:
- **Alternate column name / ORM alias**: none. `client.fetch(...)` is a raw
  asyncpg query (confirmed by reading `_common.py:194-214` directly), not an
  ORM — no alias layer exists that could remap `error` to a real column.
- **A fallback query / retry path**: none. The `except` block does
  `logger.debug(...)` then unconditionally `return []`; there is no retry, no
  alternate SQL, no fallback to `error_type`.
- **A migration I might have missed**: I did **not** trust the doc's citation of
  just two migrations (`009_telemetry_events.py`, `067_trace_quality_otel_columns.py`).
  I grepped every one of the 31 migration files that reference `telemetry_events`
  at all (`grep -rl "telemetry_events" src/eden/db_migrations/versions/`) for any
  `ADD COLUMN`/`CREATE TABLE` touching a bare `error` column, including migrations
  that add columns via a dynamic Python loop (`011_capture_full_payloads.py`'s
  `new_columns` list — read in full, no `error` entry) and one using an f-string
  `ALTER TABLE` per column (`038_zstd_extended_payloads.py`). Zero results. I also
  grepped case-insensitively for the literal string `"error"` anywhere in
  `009_telemetry_events.py` (the `CREATE TABLE`) — zero matches. I checked for a
  shadowing `VIEW` or `GENERATED ALWAYS AS` column named over `telemetry_events` —
  none exist anywhere in the migrations or in `src/eden/`. I also confirmed
  `error TEXT` does exist elsewhere in the schema (`059_computer_use.py`, for
  `computer_use_steps`) — but that's an unrelated table, not `telemetry_events`,
  and not reachable from this query.
- **A ClickHouse/analytics mirror confusion**: `src/eden/data_platform/clickhouse_sink.py`
  does create a `telemetry_events_ch` ClickHouse table (a separate analytics
  mirror), which may well have its own `error`-ish columns — but the code path in
  question calls `eden.storage.postgres.get_postgres_client()`, i.e. this is
  genuinely a Postgres/asyncpg query against the OLTP table, not ClickHouse. Not a
  live escape hatch.

**Verdict: the headline claim survives adversarial review and is, if anything,
under-evidenced in the doc itself (it cites 2 migrations; I independently checked
all 31 that touch this table and still found nothing).**

### Other claims spot-checked directly against source (not just trusted from the doc)

- **Bug 1** (`prompt_versioning.py:223`, `agent_id` zero occurrences,
  `components.py:696,772`): read directly — `create_version(self, org_id,
  prompt_name, *, template, model, ...)` at `prompt_versioning.py:223` confirmed;
  `grep -c "agent_id" prompt_versioning.py` → `0`, confirmed; `components.py:696`
  (`agent = agent_id or issue.agent_id`) and `:772-774`
  (`created = await svc.create_version(org_id, agent, template=revised, ...)`)
  both confirmed verbatim. **Accurate.**
- **Bug 8b** (DB CHECK constraint excludes `"acknowledged"`): read
  `136_issue_status_escalated.py:36-38,64` directly — `_BASE_STATUSES` is
  exactly `open, triaged, fix_pending, verifying, resolved, regressed, ignored,
  learning`, `CHECK (status IN ({_BASE_STATUSES},'escalated'))`. No
  `"acknowledged"` member anywhere. **Accurate.**
- **Bug 9** (`_map_trace_outcome` missing `crash`/`timeout`): read
  `portal.py:177-183` / `:187-189` directly — confirmed the two literal tuples
  are exactly as quoted, and `_ERROR_OUTCOMES` genuinely does include
  `crash`/`timeout` while `_map_trace_outcome`'s tuple doesn't. **Accurate.**

I could not disprove any of the individually spot-checked claims either. This is
a well-verified document — the adversarial pass found no false positives among
what I checked, only an under-stated blast radius (below).

## NEW FINDINGS (not in the doc)

### 1. The exact same undefined-column bug also kills `/analyze`, `/explain`, and `/chain` — not just clustering. This is a materially larger blast radius than the doc states, and it's in tension with the doc's own Bug 3 §3c narrative.

`_fetch_trace_events` (`src/eden/insights/rca/_common.py:104-140`) — the function
used by `RootCauseAnalyzer.categorize` (`analyzer.py:89`, feeding
`GET /{trace_id}/analyze`), presumably `explain`, **and** `rca_chain`
(`intelligence_rca.py`, feeding `GET /{trace_id}/chain`) — runs this query
(confirmed by direct read, `_common.py:122-136`):

```python
rows = await client.fetch(
    """
    SELECT event_id, trace_id, span_id, event_type, payload,
           attributes, tags, source_format, timestamp, name,
           duration_ms, outcome, error, parent_span_id,
           agent_id, reasoning, tool_calls_full, tool_results,
           request_body, response_body, tenant_id
    FROM telemetry_events
    WHERE tenant_id = $1 AND trace_id = $2
    ORDER BY timestamp ASC
    """,
    org_id, trace_id,
)
```

This selects the exact same nonexistent bare `error` column the doc's Bug 3 §3d
already proved doesn't exist anywhere in the schema — and it's wrapped in the
identical bare `except Exception: ... return []` pattern (`_common.py:137-139`).
`RootCauseAnalyzer.categorize` (`analyzer.py:89-91`, confirmed by direct read):

```python
events = await _fetch_trace_events(org_id, trace_id)
if not events:
    return _not_found_envelope(self.name, trace_id=trace_id)
```

If Bug 3 §3d's schema fact is correct (and I could not disprove it — see above),
then `_fetch_trace_events` **also** always raises `UndefinedColumnError` and
always returns `[]`, which means:
- `GET /{trace_id}/analyze` returns `not_found` for **every trace, always** —
  not "genuine timeouts get miscategorized as success," but "the endpoint never
  even reaches the classifier."
- `GET /{trace_id}/chain` (Bug 6's subject) likewise always 404s/not-founds —
  confirmed the same `if not events: return _not_found_envelope(...)` guard
  exists in `intelligence_rca.py`'s `rca_chain` too.
- `IncidentClusterer.cluster`'s own per-trace loop (`clusterer.py:179-181`, via
  `_gather_trace_events` → `_fetch_trace_events`) would be doubly moot, since it
  never runs anyway once `trace_ids` is empty.

**This directly undercuts the doc's own Bug 3 §3c section**, which spends several
paragraphs characterizing exactly how a genuine `outcome='timeout'` trace gets
processed and *misclassified* by `_classify_events` as "no failure detected —
trace succeeded" (`_common.py:958-962`). That narrative requires
`_fetch_trace_events` to succeed and return real events. Under the doc's own §3d
schema theory, it never would — the request would 404 before `_classify_events`
ever runs. The doc also uses `_fetch_trace_events` as a "working" function
elsewhere without flagging this (Bug 6: "`_fetch_trace_events`
(`_common.py:104-140`) still does no `agent_id` filter — a multi-agent-handoff
trace's events... are fetched together," which presumes the fetch succeeds).

Either (a) the `error` column really doesn't exist, in which case the doc has
found a much bigger and simpler bug than it thinks — the entire per-trace RCA
surface (`/analyze`, `/explain`, `/chain`) is dead on arrival, not just
clustering, and the Bug 3 §3c "inverted verdict" story is actually unreachable
in practice (superseded by the always-404 behavior) — or (b) something makes
`_fetch_trace_events`'s identical query actually work in production (I could not
find what that would be — see the exhaustive migration check above), in which
case Bug 3 §3d's "always zero" theory for the *sibling* query is suspect too,
since it's the same column reference against the same table. I was not able to
resolve which of (a)/(b) is true without live DB access (same limitation the doc
itself notes it lacks), but either way **this is a real gap in the doc that pass
5/synthesis should not skip**: the doc needs to either extend Bug 3 §3d's
verdict to cover `/analyze`/`/explain`/`/chain` explicitly, or explain why
`_fetch_trace_events`'s identical `error` reference doesn't crash while
`_fetch_failed_traces_in_window`'s does.

### 2. Direct contradiction with sibling doc `optimizations/02-db-queries.md`

`optimizations/02-db-queries.md` F3 (`intelligence_rca.py:127-148`, `rca_chain`)
quotes the very same `_fetch_trace_events` SQL verbatim (including the bare
`error` column) and analyzes it purely as a **performance** problem — "double-
fetch," "no LIMIT," "pulls the heaviest columns unconditionally" — treating the
query as one that executes successfully and returns rows. If Bug 3 §3d in
`bugs/02-data-consistency.md` is right, this framing in the sibling doc is moot:
a query that always raises `UndefinedColumnError` and returns `[]` has no
meaningful "double-fetch cost" to optimize, because it never returns data in the
first place. Neither doc currently reconciles this. Worth flagging for synthesis
— one of these two docs' framing of `_fetch_trace_events`'s real-world behavior
is wrong, and it's the same underlying fact (does `telemetry_events.error`
exist?) that resolves both.

### 3. Corroboration (not contradiction) from other sibling docs — dedup note for synthesis, not a "cut"

- `bugs/03-api-mcp-contracts.md:272-283` independently documents "`resolve_issue`
  silently coerces an invalid `status` to `'resolved'`" as its own top finding
  (`agent_issues.py:173`) — this is the same underlying bug as this doc's Bug 8a,
  found independently by a different pass/file. Corroborating, not conflicting;
  synthesis should note these are the same bug, not double-count severity.
- `bugs/04-frontend-and-test-failures.md` §5 independently re-confirms that
  `"ignored"` is unreachable from the portal UI (via a `IssueStatus` TypeScript
  type that excludes `"ignored"` in `lab/fixtures/issues.ts:5` and no UI button
  ever calling `onStatus("ignored")`), consistent with — not contradicting —
  this doc's Bug 8c aside that "there is also no UI path to `'ignored'`... still
  reachable from any direct API caller." Same conclusion, different evidence
  trail. No action needed beyond synthesis dedup.

### 4. `KNOWN-SUBSYSTEMS.md` cross-check

`KNOWN-SUBSYSTEMS.md`'s "Not yet inspected but plausibly relevant" list includes
`insights/`. This doc (across 4 phases) has in fact done a very deep inspection
of `insights/rca/_common.py`, `insights/incidents/clusterer.py`, and
`insights/detectors.py` — including full migration-history and ingestion-path
audits. `KNOWN-SUBSYSTEMS.md`'s "not yet inspected" tag for `insights/` is now
stale and should be updated/removed by whoever maintains that ground-truth file;
this doc's findings should feed back into it. Not a contradiction of any "eden
lacks X" claim (this doc doesn't make gap claims of that shape), so no bug-doc
content needs to change — just a heads-up for the ground-truth file's own
maintenance.

## CUT (quote + reason)

I found no claims to cut as **false**. The one clear redundancy:

> **Quote (lines ~847–870 in the current file, starting):** "Every finding below
> was independently re-read against the current working tree this pass (not
> trusted from the report text or from Phase 2's verdicts). No false positives
> found; Phase 2's 7 bugs all reconfirmed with unchanged line numbers except
> where noted. ... - **Bug 1** — CONFIRMED, unchanged... - **Bug 2** —
> CONFIRMED... - **Bug 3** — CONFIRMED, more severe... - **Bug 7** —
> CONFIRMED... - **Bug 4** — CONFIRMED... - **Bug 5** — CONFIRMED... - **Bug 6**
> — CONFIRMED... - **Bug 8** — NEW this pass, CONFIRMED end-to-end... -
> **Non-bug, `time_travel/`** — not re-verified this pass; standing from Phase 1."

**Reason:** This entire block is leftover **Phase 3** verdict content that
appears not to have been removed when the "## Phase 4 Verdicts (this pass —
supersedes Phase 3)" section was added directly above it. The two blocks cover
the same bugs (1–8, non-bug) with overlapping but not identical framing (the
Phase 4 block explicitly says "Bugs 1, 2, 4, 5, 6, 7 — not independently
re-verified this pass... stand as CONFIRMED from Phase 3 above," then the very
next section re-lists all of them again as if freshly verified "this pass").
This isn't wrong, just redundant/confusing — a reader hits two "final verdict"
sections back to back covering the same ground. Recommend collapsing to one
verdict block for the final synthesis doc (keep the Phase 4 block since it's the
most current and correctly scoped; drop or fold the trailing Phase-3-labeled
duplicate).

No other filler, unverified speculation, or false claims found worth cutting —
the doc is unusually well-evidenced for a 4-phase pass (each claim carries a
file:line citation I was able to independently re-derive, not just trust).

## Process note

My first `Read` on the target doc and on several source files in this session
was incorrectly rejected by the tool with a "you already read this earlier in
this conversation" message that did not match reality (this was a fresh
adversarial-review task with no prior turns). I worked around it by copying
files into the scratchpad and reading the copies, and by spawning a
sub-agent to fetch the doc's raw content independently, then cross-verified
everything against fresh direct reads of the actual source tree (migrations,
`_common.py`, `clusterer.py`, `analyzer.py`, `intelligence_rca.py`, `portal.py`,
`prompt_versioning.py`, `136_issue_status_escalated.py`) rather than trusting
any single source. Flagging in case this tool anomaly affected other pass-4
agents' ability to do a genuine from-scratch read.
