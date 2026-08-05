# Bug hunt: agent-identity & status data consistency

Scope: concrete consistency bugs stemming from (a) eden's two competing agent-identity
systems (`agent_registrations` in `api/routes/agents.py` vs. fleet-identity's
`register_agent_identity` in `agent_intel/performance.py`, where re-registration fires
a "drift" alert), (b) `agent_id` being optional at ingestion
(`api/routes/ingestion.py` falls back to an `X-Eden-Agent-Id`/`X-Agent-Id` header, then
silently accepts the event with `agent_id = None` if neither is present), and
(c) — new in this pass — client-supplied enum-ish strings (`outcome`, issue `status`)
being coerced or matched against the wrong vocabulary before triggering real side
effects or database writes.

**Severity ranking (Pass 5 synthesis — supersedes Phase 4's ranking):** **Bug 9** — the
portal's own trace list/detail status badge rendering green "ok" for `timeout`/`crash`
traces, live today on every trace page view, ~2 weeks old — is the **single worst
finding** in this doc. Phase 4 had provisionally ranked Bug 3 (the incident-clustering
schema bug, `_fetch_failed_traces_in_window` referencing a `telemetry_events.error`
column that **does not exist anywhere in the schema**, confirmed via a full
migration-history audit — see Bug 3 §3d) as the worst finding, on pure code-correctness
grounds: every call raises `asyncpg.UndefinedColumnError`, silently swallowed by a bare
`except Exception: return []`, so `POST /incidents/cluster` returns `{"clusters": [],
"total_failed_traces": 0}` unconditionally, for every org, on every call. **That ranking
is demoted this pass (see §3e below):** the entire `rcaApi` frontend surface that would
reach this and the sibling `/analyze`/`/chain` routes was deleted from the portal 3 days
before this review as verified, zero-consumer dead code, and no MCP tool or SDK reaches
these routes either — so the bug is real and unconditional but has **zero live product
blast radius today**. Bug 9, by contrast, has no such caveat: it sits directly in the
primary customer-facing trace UI with no dead code between it and every org's users.
Phase 4 also precisely characterized which trace populations hit Bug 3's inverted-verdict
condition (§3c), and this pass adds a further wrinkle to that finding (§3f) — plus a
timezone-handling gap in ingestion timestamp normalization inconsistent with the care
taken elsewhere in the codebase (Bug 10). Bug 4 (agent-cards ghost split) and Bug 8
(`"acknowledged"` no-op) both stand fully reconfirmed, unchanged, as documented below,
and remain live, high-blast-radius findings in their own right; Bug 8's write-up now also
covers a full audit of every other status-transition control in the issues board (§8c) —
none of the others are broken.

## Bug 1: prompt-evolution silently creates orphan prompts instead of
## evolving the agent's real prompt

**File:line:** `src/eden/agents/evolution/components.py:772` (`IssuePromptEvolver.evolve_from_issue`,
`agent = agent_id or issue.agent_id` at `:696`) calling into
`src/eden/services/prompt_versioning.py:223` (`PromptService.create_version`).

```python
created = await svc.create_version(
    org_id,
    agent,              # <-- passed positionally as prompt_name
    template=revised,
    ...
)
```

`create_version(self, org_id, prompt_name, *, template, model, ...)` — confirmed
signature unchanged at `prompt_versioning.py:223`. `agent_id` has **zero** occurrences
anywhere in `prompt_versioning.py` (confirmed via `grep -c`) — prompts are keyed purely
by `(org_id, prompt_name)`, so this call implicitly assumes `agent_id == prompt_name`.
`create_version` calls `self.get_prompt(org_id, prompt_name)` first (`:240`); if no
prompt exists under that exact name it falls through to `create_prompt(...)` at `:242`
and creates a **brand-new, unrelated prompt row** instead of versioning the agent's
actual production prompt. `agent_id` is frequently a server-minted UUID
(`AgentRegisterRequest.agent_id: str | None = None`), so in the common case where an
org's prompt template name doesn't equal its agent's UUID, every issue-resolution
prompt evolution silently creates an orphan prompt named after a UUID.

**Phase 3 re-check:** all cited lines (`:696`, `:772`, `prompt_versioning.py:223/240/242`)
confirmed unchanged. **This bug is also now directly reachable from a second call
site** — see Bug 8 below: `resolve_issue`'s "resolved" branch (`agent_issues.py:201`)
calls `IssuePromptEvolver().evolve_from_issue` unconditionally, including when the
`target` status was silently coerced from an unrecognized value rather than genuinely
requested — i.e. Bug 8's mis-coercion can *trigger* Bug 1's orphan-prompt creation on
a resolve the caller never actually asked for.

**Fix:** `evolve_from_issue` must resolve the agent's real prompt name, not reuse
`agent_id`, and must fail loudly rather than silently minting a prompt:

```python
# components.py — replace the direct agent-id pass-through
prompt_name = await self._resolve_prompt_name(org_id, agent)  # e.g. agent_registrations.prompt_name,
                                                                # or an explicit AgentRegistration field
if prompt_name is None:
    logger.warning("evolve_from_issue: agent %r has no registered prompt_name; skipping evolution", agent)
    return None
created = await svc.create_version(org_id, prompt_name, template=revised, ...)
```

If no such mapping exists yet in the schema, the minimal safe change is to make
`create_version` (or a new `create_version_strict`) refuse to auto-`create_prompt`
when called from an automated evolution path — i.e. evolution should only ever version
an *existing* prompt, never mint one implicitly.

## Bug 2: events with NULL `agent_id` are silently dropped from prompt-evolution scoring, not surfaced as a gap

**File:line:** `src/eden/agents/evolution/components.py:78` (comment: `"# telemetry
event are dropped (their agent_id would be NULL)"`), `:93`
(`AND te.attributes->>'agent_id' IS NOT NULL`).

**Phase 3: upgraded from "likely real, unverified" to CONFIRMED** — independently
re-read via `rg` this pass (both lines match verbatim). Because ingestion accepts
events with no `agent_id`, those events are quietly excluded from the judge-score /
evolution-trigger aggregation. No counter, log, or alert surfaces how many events are
dropped — an org with spotty `agent_id` coverage sees prompt evolution under-fire with
no visible signal explaining why.

**Fix:** add a sibling `COUNT(*) FILTER (WHERE te.attributes->>'agent_id' IS NULL)` to
the same query window and log/emit it, e.g.:

```python
null_dropped = row["null_agent_id_count"]
if null_dropped:
    logger.info("evolution: dropped %d NULL-agent_id events from scoring window (org=%s)", null_dropped, org_id)
    metrics.increment("evolution.dropped_null_agent_id", null_dropped)
```

## Bug 3: `outcome == "error"` checks a value that never occurs — timeout/crash
## failures are structurally excluded from RCA, and (new) actively mis-categorized
## as successes

**File:line:** `src/eden/api/routes/intelligence_rca.py:68-69`:

```python
def _event_failed(ev: dict[str, Any]) -> bool:
    return bool(ev.get("error")) or ev.get("outcome") == "error"
```

Per the canonical `TelemetryEvent` schema (`src/eden/observability/telemetry_collector.py:61`):

```python
outcome: str | None = None  # "success", "failure", "partial", "timeout", "crash"
```

`"error"` is not a member of this vocabulary — confirmed producers use it correctly
elsewhere in the same file (`telemetry_collector.py:2270`: `if outcome and outcome !=
"success":`; `:2275`: `"severity": "high" if outcome in ("failure", "crash") else
"warning"`). So `outcome == "error"` is dead against real data everywhere it appears.

**Phase 3: all previously-cited duplicate sites reconfirmed at their exact lines**,
plus **two additional duplicate sites found this pass that were not in the original
report**:

1. `src/eden/insights/rca/_common.py:204` — SQL candidate query,
   `_fetch_failed_traces_in_window` (def at `:178`):
   ```sql
   WHERE tenant_id = $1 AND timestamp > NOW() - $2::interval
     AND (error IS NOT NULL OR outcome = 'error')
   ```
   A trace whose only failed event has `outcome='timeout'`/`'crash'` and a `NULL`
   `error` column never becomes a clustering candidate — structurally excluded before
   clustering runs.
2. `src/eden/insights/rca/_common.py:862-870` (`_trace_is_failure`) — `if
   ev.get("outcome") == "error":` at `:866`. Used as the Rule-7 fallback gate inside
   `_classify_events` (`:947`, see below).
3. `src/eden/insights/rca/_common.py:1002-1011` (`_error_type_from_event`) — `if
   ev.get("outcome") == "error":` at `:1009`; falls through to `"unknown"` for a bare
   `str` `error` or a real timeout/crash outcome either way.
4. **New this pass** — `src/eden/insights/rca/_common.py:728-745` (`_has_tool_error`,
   "Rule 1" of the shared 6-rule classifier): `if err or (ev.get("outcome") ==
   "error"):` at `:737`. Docstring literally says `outcome="error"` (`:730`), inheriting
   the same wrong vocabulary.
5. **New this pass** — `src/eden/insights/rca/_common.py:992-999`
   (`_first_failed_event`): `if ev.get("error") or ev.get("outcome") == "error":` at
   `:997`. This is the function that picks the representative event for both RCA
   categorization detail and the Bug 7 cluster key (`clusterer.py:186-188`) — so a
   trace whose *only* structured failure is `outcome='timeout'` with no `error` object
   falls through to `events[0]` (an arbitrary, likely non-failing event) as the "first
   failed event," further corrupting the `error_type`/`agent_id` used to build the
   cluster key.

**Worse consequence found this pass — active mis-categorization, not just exclusion.**
`_classify_events` (`_common.py:901-962`) is the shared rule engine used by *both*
`RootCauseAnalyzer.categorize` (`analyzer.py:94`, feeding `GET
.../rca/{trace_id}/analyze`) *and* `IncidentClusterer.cluster` (`clusterer.py:185`).
Rule 1 (`_has_tool_error`) is checked first and is dead for timeout/crash tool calls
per point 4 above. Rule 7's fallback (`:947`, gated on `_trace_is_failure`) is *also*
dead for the same outcome values per point 2. Contrast with **Rule 5**
(`_has_memory_error`, `_common.py:826-841`), which uses the *correct* idiom
(`if ev.get("outcome") and ev.get("outcome") != "success":` at `:833`) — proving the
right pattern is already known and used elsewhere in the very same file, just not
applied consistently. Net effect: a trace whose only failure is a `tool.*` event with
`outcome='timeout'` and no populated `error` dict falls through every rule and lands in
`_classify_events`'s final branch (`:958-962`):
```python
return ("model", 0.40, ["no failure detected — trace succeeded"])
```
**A genuine timeout is reported by `/analyze` as "no failure detected — trace
succeeded."** This is not a missed-detection edge case, it's an inverted verdict on the
platform's own root-cause-analysis endpoint.

**Phase 4 — §3c: precise blast-radius characterization, traced ingestion-path by
ingestion-path (per-trace `/analyze`, not the clustering candidate query — see §3d
for why that path is broken in a different, worse way).** There is no live DB in this
environment to query real counts; instead this pass traced every producer of the
`outcome` field to determine exactly which real traces can and cannot ever produce
the literal string `"error"` that `_event_failed` et al. check for:

1. **NOT affected — official Python SDK, default path.** `sdk/python/eden_sdk/trace.py`
   `Span.finish` (`:139-148`): `if error is not None: self.outcome = "error"`. Any app
   that lets an exception propagate into the SDK's own `with eden.trace(...)` /
   `span.finish(error=...)` machinery stores outcome=`"error"` **verbatim** — this
   *is* caught correctly by `_event_failed`. Same for the TS SDK
   (`sdk/ts-ai/src/trace.ts:329-354`, `hasError = outcome === "error"`). The direct-SDK
   default-failure path is not dead code — the doc's prior "dead against real data
   everywhere" claim was too broad for this specific path.
2. **100% affected — OpenTelemetry ingestion.** `src/eden/observability/ingestion/otel.py`
   `_span_to_raw_dict` (docstring `:204`: `` status.code STATUS_CODE_ERROR → outcome =
   failure``; implementation `:279-290`): `if status_code == "STATUS_CODE_ERROR" or
   error_type: outcome = "failure"`. This is the *only* value ever assigned on the OTel
   path — never `"timeout"`, never `"crash"`, never `"error"`, even when
   `attrs.get("error.type")` is literally `"TimeoutError"`. Every OTel-sourced failed
   span (any customer using a standard OTel collector, Datadog exporter, or
   OTel-based framework auto-instrumentation — the same integration surface
   implicated in Bug 4's ghost cards) is structurally guaranteed to hit the dead
   condition; there is no code path by which it could ever match.
3. **100% affected — webhook / third-party-provider ingestion.**
   `src/eden/observability/ingestion/normalizer.py` `_coerce_outcome` (`:81-106`)
   explicitly maps `"error"` (and `"errored"`, `"fail"`, `"failed"`) → `"failure"`
   (`:95-97`) before the event is ever persisted. So even a provider (langsmith,
   langfuse, a custom webhook) that reports its failure using the exact word
   `"error"` never reaches the DB as `"error"` — it's rewritten to `"failure"` by the
   platform's own normalizer, then falls into the same dead condition. Confirmed via
   test fixture `tests/unit/observability/ingestion/test_normalizer.py:71-73`
   (`_coerce_outcome("timeout") == "timeout"`, `_coerce_outcome("crash") == "crash"`).
   `otel.py` also funnels through this same normalizer (`normalize_to_telemetry_event`,
   referenced in its module docstring at `:195`), so §2 and §3 are the same underlying
   mechanism from two entry points.

Net: for a platform whose core value proposition is multi-framework/multi-provider
ingestion, the two paths that are 100% affected (OTel + third-party webhook) are not
edge cases — they are the primary ingestion mode for any customer not using the
first-party SDK's raw exception-to-`finish(error=...)` pattern, or any first-party-SDK
user who explicitly calls `set_status(outcome="timeout")` per the documented
vocabulary (`telemetry_collector.py:61`) instead of relying on the implicit
`error="..."` default.

**Phase 4 — §3d: the SQL candidate-query site (`_common.py:198-213`) doesn't just
exclude timeout/crash traces — it never returns any candidate, ever, because it
references a column that was never created.** Full migration-history audit of
`telemetry_events`:
- `src/eden/db_migrations/versions/009_telemetry_events.py:39` creates the table;
  no `error` column.
- `src/eden/db_migrations/versions/067_trace_quality_otel_columns.py:69` adds
  `error_type VARCHAR(128)` — the *only* error-related column ever added to this
  table across the full migration history (`grep`-verified across every migration
  touching `telemetry_events`). No migration ever adds a bare `error` column.
- `TELEMETRY_INSERT_SQL` (`telemetry_collector.py:289-315`, the single INSERT every
  write path shares) does not list `error` among its 48 columns either — consistent
  with the column not existing.

So `_common.py:204`'s `WHERE ... AND (error IS NOT NULL OR outcome = 'error')` runs
against a genuinely undefined column. Postgres raises `UndefinedColumnError` on the
very first execution; `_fetch_failed_traces_in_window`'s `try/except Exception` at
`:211-213` catches it and does `logger.debug(...)` (below default log level in most
deployments) then `return []`. `IncidentClusterer.cluster` (`clusterer.py:155-170`)
treats an empty list as the legitimate "no failed traces" case and returns a normal
`_ok_envelope` with `total_failed_traces: 0, clusters: []` — **HTTP 200, no error, no
degraded flag** — from `POST /incidents/cluster` (`intelligence_rca.py:157-166`,
routed and reachable). This is independent of, and more severe than, the
outcome-vocabulary bug: even a trace with outcome literally `"error"` never becomes a
clustering candidate, because the query never executes successfully in the first
place. This is likely why no one has noticed Bug 3's clustering-side impact — the
symptom looks identical to "this org just has no incidents."

**Fix (§3d, in addition to the existing fix below):** drop the non-existent `error`
reference and use the real `error_type` column plus the corrected outcome idiom:
```sql
WHERE tenant_id = $1 AND timestamp > NOW() - $2::interval
  AND (error_type IS NOT NULL OR (outcome IS NOT NULL AND outcome <> 'success'))
```
Separately, `_fetch_failed_traces_in_window`'s catch-all should log at `warning` (or
re-raise for a 5xx), not `debug` — a permanently-broken production query silently
downgraded to `[]` needs to be loud, not invisible.

**Fix — single shared idiom, one place.** Replace every `outcome == "error"` (Python
and SQL) with the idiom the codebase itself already uses correctly at
`telemetry_collector.py:2270` and `_common.py:833`: "any outcome that isn't exactly
`success`" (leaves room for `partial` to be handled distinctly downstream if desired,
but never silently treated as clean):

```python
# _common.py — new shared helper, replaces 5 duplicated inline checks
def _outcome_is_failure(ev: dict[str, Any]) -> bool:
    outcome = ev.get("outcome")
    return bool(ev.get("error")) or bool(outcome and outcome != "success")
```
Then: `_event_failed` (`intelligence_rca.py:68-69`), `_has_tool_error` (`:737`),
`_trace_is_failure` (`:866`), `_first_failed_event` (`:997`), and
`_error_type_from_event`'s outcome check (`:1009`, falls back to `outcome` itself as
the type string instead of the useless literal `"error"`) should all call this one
helper instead of re-deriving the check. SQL site (`_common.py:204`):
```sql
AND (error IS NOT NULL OR (outcome IS NOT NULL AND outcome <> 'success'))
```

**§3e (Pass 5 synthesis) — reachability correction: zero live product blast radius
today.** The severity ranking above needs a correction this doc's earlier passes never
checked: **the entire `rcaApi` frontend surface — `analyze`, `explain`,
`clusterIncidents`, `listIncidents`, `summarizeIncident` — was deleted from the portal
3 days before this review**, as a verified, intentional, zero-consumer dead-code prune
(`clients/portal/src/lib/api/__tests__/dead-code-removal.test.ts` now regression-guards
that `rcaApi` stays deleted). `bugs/03-api-mcp-contracts.md` independently found and
documented the same underlying fact — that the RCA chain/investigate routes are
"backend-only: zero portal callers, absent from the 28-tool MCP catalog" — without
cross-referencing this doc. No SDK calls these routes either. Net effect: `POST
/incidents/cluster` (§3d), `GET .../analyze`/`explain` (§3a–c), and `GET .../chain`
(Bug 6) are all still routed and reachable by a direct, undocumented REST call, but
**today there is no portal button, MCP tool, or SDK method that reaches any of them.**
The underlying code bugs are unaffected by this — §3d's schema gap is still an
unconditional, data-independent bug, and §3c's inverted-verdict finding is still true
of the code as written — but the doc's severity claims must account for it: **Bug 3 no
longer ranks as this doc's worst finding.** That slot goes to Bug 9 (below), which has
no such reachability caveat.

**§3f (Pass 5 synthesis) — the same undefined-column reference is also selected by
`_fetch_trace_events`, which backs `/analyze`, `/explain`, and `/chain` — not just
clustering, with an unresolved tension against this doc's own §3c narrative.**
`_fetch_trace_events` (`src/eden/insights/rca/_common.py:104-140`) is the per-trace
event-fetch helper behind `RootCauseAnalyzer.categorize` (feeding `/analyze`),
presumably `/explain`, and `rca_chain` (feeding `/chain`, Bug 6's subject). Its SQL
(line 127) selects the identical bare `error` column:

```python
SELECT event_id, trace_id, span_id, event_type, payload,
       attributes, tags, source_format, timestamp, name,
       duration_ms, outcome, error, parent_span_id,      # <-- same undefined column as §3d
       agent_id, reasoning, tool_calls_full, tool_results,
       request_body, response_body, tenant_id
FROM telemetry_events
WHERE tenant_id = $1 AND trace_id = $2
ORDER BY timestamp ASC
```

wrapped in the same bare `except Exception: ... return []` pattern. **If §3d's schema
theory is correct — and this pass found no way to disprove it — then
`_fetch_trace_events` would also always raise `UndefinedColumnError` and always return
`[]`**, which would mean `GET /{trace_id}/analyze` returns `not_found`
(`analyzer.py:89-91`: `if not events: return _not_found_envelope(...)`) for *every*
trace, always — not "genuine timeouts get miscategorized as success" (§3c), but "the
endpoint never reaches the classifier in the first place." The same guard exists in
`rca_chain` for `/chain`.

**This is flagged honestly, not resolved, because it is in real tension with this
doc's own §3c narrative**, which spends several paragraphs characterizing exactly how a
genuine `outcome='timeout'` trace is fetched, classified, and *misclassified* as "no
failure detected — trace succeeded" — a story that requires `_fetch_trace_events` to
succeed and return real events. Bug 6 (below) also cites `_fetch_trace_events` as a
working function without flagging this ("`_fetch_trace_events` ... still does no
`agent_id` filter — a multi-agent-handoff trace's events ... are fetched together,"
which presumes the fetch succeeds). Two readings are both consistent with the evidence
gathered so far: either (a) the `error` column really doesn't exist and this is a
bigger, simpler bug than §3c describes — the entire per-trace RCA surface is dead on
arrival, and §3c's inverted-verdict story is actually unreachable in practice
(superseded by an always-`not_found` response) — or (b) something not yet identified
makes `_fetch_trace_events`'s identical query succeed in production, in which case
§3d's "always zero" theory for the sibling clustering query deserves a second look too,
since it's the same column reference against the same table. This pass could not
resolve (a) vs. (b) without live DB access (the same limitation §3c/§3d already note);
whoever picks up this fix should resolve the ambiguity before relying on either
narrative. **Regardless of which reading is correct, the §3e reachability correction
still holds** — none of `/analyze`, `/explain`, or `/chain` has a live caller today, so
this ambiguity does not change Bug 3's demoted ranking.

(Informational, not a new bug in this doc: `optimizations/02-db-queries.md`'s F3
analyzes this same `_fetch_trace_events` query purely as a performance problem —
double-fetch cost, missing `LIMIT`, unconditionally pulling heavy columns — framing that
implicitly assumes the query executes and returns rows. If reading (a) above is
correct, that framing is moot, since a query that always raises and returns `[]` has no
meaningful row-fetch cost to optimize. Neither doc currently reconciles this; flagged
here for whoever owns `optimizations/02-db-queries.md` to reconcile, not resolved in
this doc.)

## Bug 7: missing `agent_id` doesn't get excluded — it silently merges unrelated agents into a shared `"unknown"` bucket in RCA clustering and issue fingerprinting

**Phase 3: all lines reconfirmed unchanged.**

1. `src/eden/insights/incidents/clusterer.py:188-189`:
   ```python
   agent_id = _agent_id_from_event(first)
   key: tuple[str, str, str] = (category, error_type, agent_id)
   ```
   `_agent_id_from_event` (`_common.py:1014-1018`) returns the literal `"unknown"` when
   `ev.get("agent_id")` is falsy. Two unrelated agents' failures sharing only
   `(category, error_type)` land in the same incident cluster if neither reported
   `agent_id`. With `min_cluster_size` defaulting to 3 (`ClusterRequest` in
   `intelligence_rca.py:45`), this can manufacture a false multi-trace incident. The
   cluster's own "top affected agents" summary (`clusterer.py:344-345`, confirmed:
   `if isinstance(aid, str) and aid: agent_counts[aid] += 1`) then *skips* falsy-`agent_id`
   events entirely — the merged cluster can't self-report who's responsible.
2. `src/eden/issues/fingerprint.py:88` (confirmed unchanged):
   ```python
   raw = f"{kind}|{agent_id or 'unknown'}|{error_signature}"
   ```
   Two different agents' first-ever occurrence of the same `(kind, error_signature)`,
   both missing `agent_id`, hash identically — the second agent's incident is silently
   absorbed into the first agent's issue (burst-dedup path) and never becomes its own.
3. `src/eden/issues/repo.py:174-176` (confirmed unchanged): `if agent_id:
   clauses.append(f"agent_id = ${len(args)}")`. The DB column stores real `NULL` (the
   `"unknown"` string only ever exists inside the fingerprint hash), so any issue
   created from an agent_id-less event is invisible from every per-agent-filtered view
   (`GET /issues?agent_id=...`).

**Fix:** stop using a literal shared sentinel for the cluster/fingerprint key. Scope the
fallback to something that can't collide across genuinely different agents/traces —
e.g. key on the trace_id when agent_id is missing instead of a global constant:
```python
def _agent_id_from_event(ev: dict[str, Any]) -> str:
    aid = ev.get("agent_id")
    if isinstance(aid, str) and aid.strip():
        return aid
    trace_id = ev.get("trace_id") or "?"
    return f"__unattributed__:{trace_id}"
```
This preserves burst-dedup for the *same* trace re-firing the same issue while no
longer merging two different agents' first-ever occurrences just because both omitted
`agent_id`. (`fingerprint.py:88` should use the same helper rather than its own
`or 'unknown'`.)

## Non-bug, ruled out: `time_travel/` is NOT agent_id-dependent

Not independently re-verified this pass (low-stakes negative finding); original
Phase-1 grep (zero `agent_id` matches in `recorder.py`/`replayer.py`) stands unless a
future pass says otherwise.

## Bug 4 (high severity — see Verdicts for current ranking): portal "Agent Cards"
## dashboard splits one logical agent into a false-idle ghost card and an
## unrecognizable "rogue" ghost card

**File:line — all reconfirmed unchanged this pass:** `src/eden/api/routes/portal.py:886`
(`_load_registry`), `:929` (`_load_metrics`), `:1063` (`_load_open_issues`), merge logic
`:1100-1101` + loop at `:1151-1177` (SDK-only-agents loop starts `:1165`, ghost card
built `:1166-1177`).

1. `_load_registry` lists agents purely from `agent_registrations`, keyed by its
   `agent_id` column.
2. `_load_metrics` independently computes per-agent runs/cost/success by `GROUP BY
   agent_id` over `telemetry_events`, where `agent_id` is whatever string got stamped
   onto each event at ingest — which may differ from `agent_registrations.agent_id`
   (header value, `project_id`, or a framework auto-instrumentation label like
   `pydantic-ai:OpenAIChatModel()`, `langchain:...`).
3. The merge (`_build`, `:1100-1101` + `:1155`) joins by **exact string equality**:
   `metrics_by_id.get(agent_id)`. No fuzzy match, no alias table.

Concrete repro: org registers `agent_id="checkout-agent"`; its SDK stamps telemetry
with the raw framework instrumentation id instead (integration gap — nothing enforces
wiring the registered id into event attributes). Result: the `"checkout-agent"` card
gets `metrics_by_id.get("checkout-agent")` → `None` → `runs=0`, `status="idle"` — reads
as dead. The same traffic produces a **second card** via the SDK-only-agents loop
(`:1165-1177`): `id="pydantic-ai:OpenAIChatModel()"`, `purpose="Seen in recent traces"`,
fully populated metrics — unrecognizable as belonging to `checkout-agent`.

Partial mitigation confirmed reused consistently: `_PREFERRED_AGENT_ID_SQL`
(`portal.py:805-820`) is applied at all four call sites this pass checked —
`:954`, `:1021` (both inside `_load_metrics`), `:1233`, `:1343` (traces list /
trace-detail endpoints) — so the "Not reached" item from the prior pass asking whether
this collapsing logic is applied consistently elsewhere is now **resolved: yes,
consistently applied**. It still only helps when *some* event on the trace carries a
non-synthetic id; if every event on the trace only ever carries the synthetic label,
the `FILTER` matches nothing, `ARRAY_AGG(...)[1]` is `NULL`, and the second `COALESCE`
branch (`:817-818`) picks the synthetic label anyway — the ghost-card outcome is
unchanged for any agent whose registration id never makes it into its own telemetry.

**Fix:** persist a real alias mapping instead of a per-query best-effort collapse.
When `_load_metrics`' `_PREFERRED_AGENT_ID_SQL` *does* successfully resolve a synthetic
label to a real `agent_id` on some trace, write that pairing to a small
`agent_identity_aliases(org_id, synthetic_label, agent_id, first_seen, last_seen)`
table. Then the merge step (`:1100-1101`) should resolve through this table *before*
falling back to raw-label ghost-card creation:
```python
resolved = alias_map.get(agent_id, agent_id)  # alias_map loaded once per request
metrics = metrics_by_id.get(resolved) or metrics_by_id.get(agent_id) or {}
```
This degrades gracefully (still ghost-cards a *never-seen-with-a-real-id* agent, which
is a genuine integration gap that needs surfacing) while fixing the common case where
the pairing was observed on *any* historical trace, not just the current window's.

## Bug 5: NULL-`agent_id` telemetry events and issues are excluded from the
## primary dashboard entirely, not just from prompt-evolution scoring (Bug 2)

**File:line — reconfirmed unchanged:** `src/eden/api/routes/portal.py:941`
(`_load_metrics`: `... AND agent_id IS NOT NULL AND timestamp > ...`) and `:1076`
(`_load_open_issues`: `... AND agent_id IS NOT NULL AND status NOT IN (...)`).

Same root cause as Bug 2, hitting the customer-facing dashboard: any trace whose events
never got an `agent_id` stamped is filtered out of `_load_metrics`'s `recent` CTE
*before* `_PREFERRED_AGENT_ID_SQL` even runs — contributes zero runs/cost/tokens to
*any* card, invisible from the whole agents view. Same pattern one layer down:
`src/eden/issues/auto_scanner.py:106,170-173` — `_infer_agent_id` returns `None` if no
event on the trace has a truthy `agent_id`, so auto-detected stumbles/issues on such a
trace are written with `agent_id=None`, and `_load_open_issues`'s filter then drops
those issues from every agent's open-issue count too — silently, no counter anywhere.

**Fix:** surface an explicit "Unattributed" card/row instead of dropping silently —
sum the excluded rows into a synthetic bucket:
```python
unattributed = await conn.fetchrow(
    "SELECT count(*) runs, sum(cost_usd) cost FROM telemetry_events "
    "WHERE org_id = $1 AND agent_id IS NULL AND timestamp > $2", org_id, window_start
)
# surface as a distinct, clearly-labeled card rather than omitting the traffic
```

## Bug 6: `agent_id` on issues/stumbles is 100% client-supplied and unvalidated
## against either identity system, and RCA chain output drops it entirely

**File:line — all reconfirmed unchanged this pass:**
- `src/eden/api/routes/signal_investigator.py:248` (`agent_id: str | None = None`),
  `:305` (`agent_id=body.agent_id,`).
- `src/eden/signals/investigator.py:363,395` — same unvalidated string flows into
  `StumbleWriter().create(StumbleCreate(..., agent_id=agent_id))`, zero cross-check
  against `agent_registrations` or the trace's own telemetry-event `agent_id`.
- `src/eden/db_migrations/versions/084_agent_issues.py:49,93` — plain `agent_id
  VARCHAR(256)`, no FK to any identity table.
- `src/eden/issues/repo.py:174-176` — exact-match filter clause, exposed as `GET
  /stumbles?agent_id=...` (`agent_issues.py:287,298`).

Repro unchanged: a caller passes the fleet-identity `display_name`/`slack_identity`
value as `agent_id` while the org's identity of record is the `agent_registrations`
UUID; the resulting stumble is stored with the fleet-identity string, and a later
`GET /stumbles?agent_id=<registered-UUID>` returns zero rows.

`_fetch_trace_events` (`_common.py:104-140`) still does no `agent_id` filter — a
multi-agent-handoff trace's events (mixed `agent_id` values) are fetched together. But
`_build_causal_chain` (`intelligence_rca.py:80-123`) still **drops `agent_id`
entirely** when projecting each event (`:100-115` includes `span_id`,
`parent_span_id`, `event_type`, `name`, `outcome`, `error_type`, `implicated` — no
`agent_id`). Confirmed via full-file search: `intelligence_rca.py` has **zero**
occurrences of `agent_id` anywhere. Note: `git log` shows the `/chain` endpoint
(`rca_chain`, `intelligence_rca.py:126-140`) was added in the most recent commit on
this file (`64233475`) — this is a brand-new gap, not aged debt.

`_event_error_type` (`intelligence_rca.py:72-77`) still only returns a value when
`ev["error"]` is a `dict` with a `type` key — `None` for a plain-string error or for
an `outcome`-only failure — compounding Bug 3's detection gap with a classification gap
even on chains that are detected.

**Fix:** add `agent_id` to the per-node dict in `_build_causal_chain`:
```python
chain.append({
    ...,
    "agent_id": ev.get("agent_id"),  # was missing entirely
    "implicated": failed,
})
```
For the identity-validation gap, at minimum resolve `body.agent_id` through the same
`_PREFERRED_AGENT_ID_SQL`-style normalization used in Bug 4's fix before writing
`StumbleCreate`, so a fleet-identity string and a registration UUID that co-occur on a
trace resolve to the same stored value.

## Bug 8 (new, Phase 3): `resolve_issue` silently coerces any unrecognized status to
## `"resolved"` — firing real side effects — and the one value the portal UI actually
## needs (`"acknowledged"`) is not a legal DB status at all

**File:line:** `src/eden/api/routes/agent_issues.py:107-114` (`ResolveRequest`,
`_RESOLVE_STATUSES`), `:167-223` (`resolve_issue`).

```python
class ResolveRequest(BaseModel):
    # Portal triage uses open|acknowledged|resolved; ignored remains for
    # soft-dismiss. ``set_status`` accepts any string — this allowlist
    # keeps the resolve endpoint from writing arbitrary values.
    status: str = "resolved"  # open | acknowledged | resolved | ignored

_RESOLVE_STATUSES = frozenset({"open", "acknowledged", "resolved", "ignored"})

async def resolve_issue(...):
    await _require_postgres()
    target = body.status if body.status in _RESOLVE_STATUSES else "resolved"
    ok = await _repo.set_status(org_id, issue_id, target, set_resolved_at=(target == "resolved"))
    ...
    if ok and target == "resolved":
        # on_issue_resolved (regression cases), RegressionRunner suite run,
        # IssuePromptEvolver().evolve_from_issue (Bug 1!), flywheel on_issue_resolved
```

**8a — silent coercion to "resolved" on any typo/out-of-scope value.** The field is a
bare `str` (line 111); despite the comment claiming the allowlist "keeps the resolve
endpoint from writing arbitrary values," line 173's ternary does the opposite of reject
— any value *not* in the 4-member set (a typo like `"acknowledge"`, or any of the
DB-legal-but-out-of-scope statuses `"triaged"`, `"escalated"`, `"regressed"`,
`"fix_pending"`, `"verifying"`, `"learning"` — see 8b) silently becomes `"resolved"`.
This isn't inert: the `resolved` branch (`:180-223`) unconditionally fires **four**
side-effect pipelines — `on_issue_resolved` (creates regression test cases),
`RegressionRunner().run_suite` (kicks off a full regression run), **`IssuePromptEvolver
().evolve_from_issue`** (Bug 1's orphan-prompt-creation path — a bad status value can
now trigger it), and the flywheel coordinator's `on_issue_resolved`. A caller (or a
future UI state name that doesn't match this hardcoded set) silently resolves an issue
and kicks off all four pipelines instead of getting a 400.

**Cross-reference:** `bugs/03-api-mcp-contracts.md` independently identified this same
coercion bug (`agent_issues.py:173`) from an API-contract-correctness angle — it's that
doc's own top-ranked finding. Convergent, independent discovery from two different
review angles; not a duplicate to dedup, just noted here as a confidence signal.

**8b — `"acknowledged"` is not a legal DB status; the resolve endpoint silently no-ops
for it today.** The actual `agent_issues.status` CHECK constraint
(`src/eden/db_migrations/versions/136_issue_status_escalated.py:36-38,64`):
```python
_BASE_STATUSES = (
    "'open','triaged','fix_pending','verifying',"
    "'resolved','regressed','ignored','learning'"
)
...
CHECK (status IN ({_BASE_STATUSES},'escalated'))
```
i.e. `open, triaged, fix_pending, verifying, resolved, regressed, ignored, learning,
escalated`. **`"acknowledged"` is not in this list.** But it *is* one of the 4 values
the API layer accepts (`_RESOLVE_STATUSES`) and — confirmed in the portal frontend —
it's the real, typed value the UI sends: `AgentIssueResolveStatus` (`clients/portal/src
/lib/api/resources.ts:2740-2744`) is `"open" | "acknowledged" | "resolved" |
"ignored"`, and the issues board (`clients/portal/src/app/(portal)/issues/issues-client
.tsx:496-520`, `setIssueStatus` / `agentIssuesApi.setStatus`) is a drag/status-change UI
that calls this with `"acknowledged"` on the "Acknowledge" action.

When that request lands: `target = "acknowledged"` passes the app-level allowlist
check, then `_repo.set_status(org_id, issue_id, "acknowledged", ...)` (`issues/repo.py
:308-332`) issues a raw parameterized `UPDATE agent_issues SET status = $3 ...`, which
Postgres rejects with a `CheckViolation` against `agent_issues_status_check`. `set_status`
wraps this in a bare `except Exception` (`repo.py:329-331`): logs `logger.warning(...)`
and **returns `False`** — no exception propagates. `resolve_issue` still returns HTTP
200 with `{"issue_id": ..., "status": target, "updated": ok}` — i.e. `updated: false`,
but the same 200 response also echoes `"status": "acknowledged"` as if it took effect.

**Product-visible consequence:** the portal's `setIssueStatus` does an optimistic
local update *before* the request resolves (`issues-client.tsx:499`), then on success
invalidates the query and clears the override, deferring to server truth; the
`catch`/toast-and-revert branch (`:510-520`) only fires if the fetch *throws* — it
never does, since the server returns 200. So the "Acknowledge" click **silently
reverts itself** on the next refetch, with **zero error toast and zero indication to
the user that anything failed** — the one status the UI board actually exercises via
this endpoint is a functional no-op today.

**Fix — both halves, minimal:**
```python
# 8a: reject, don't coerce
if body.status not in _RESOLVE_STATUSES:
    raise HTTPException(
        status_code=400,
        detail=f"invalid status {body.status!r}; must be one of {sorted(_RESOLVE_STATUSES)}",
    )
target = body.status
```
```python
# 8b: map the app-level "acknowledged" concept onto the real DB enum's "triaged"
# (the closest existing mid-flow status), instead of writing an illegal value
_STATUS_TO_DB = {"open": "open", "acknowledged": "triaged", "resolved": "resolved", "ignored": "ignored"}
db_status = _STATUS_TO_DB[target]
ok = await _repo.set_status(org_id, issue_id, db_status, set_resolved_at=(db_status == "resolved"))
if not ok:
    raise HTTPException(status_code=500, detail="failed to update issue status")
```
Separately, `set_status` (`repo.py:308-332`) should distinguish "no such issue"
(0 rows updated, legitimate `False`) from "the UPDATE itself raised" (a real error that
should propagate, not be swallowed to the same `False`) — e.g. re-raise
`asyncpg.CheckViolationError` specifically rather than the current blanket
`except Exception: return False`.

**8c (Phase 4) — full audit of every status-transition control in the issues board:
only "Acknowledge" is broken.** `agentIssuesApi.setStatus` (`resources.ts:2762-2766`)
has exactly one call site in the entire portal (`grep`-verified across
`clients/portal/src`): `issues-client.tsx:501`, invoked by the `onStatus` callback
wired from `IssueDetail` (`issues-client.tsx:727-729`). `IssueDetail` exposes three
distinct buttons, gated by current status (`issues-client.tsx:205-245`):

| Button | From status | Sends | Legal in `_RESOLVE_STATUSES`? | Legal in DB CHECK? | Result |
|---|---|---|---|---|---|
| Acknowledge | `open` | `"acknowledged"` | yes | **no** | **silent no-op (Bug 8b)** |
| Resolve | `open` or `acknowledged` | `"resolved"` | yes | yes | works |
| Reopen | `acknowledged` or `resolved` | `"open"` | yes | yes | works, but see below |

There is no drag-and-drop kanban anywhere in the portal (`grep` for
`useDrag`/`useDrop`/`onDragEnd`/`Kanban` across `clients/portal/src` returns zero
matches) — the three-column board (`byColumn`, `issues-client.tsx:552-561`) is
populated by these same three buttons, not by dragging cards. There is also no UI path
to `"ignored"` — the value exists in `_RESOLVE_STATUSES` and the DB CHECK constraint
but no component in `issues-client.tsx` ever calls `onStatus("ignored")`, so that
branch of Bug 8a's coercion is currently unreachable from the portal (still reachable
from any direct API caller). (Independently corroborated by
`bugs/04-frontend-and-test-failures.md`, which confirms the same unreachability via the
portal's `IssueStatus` TypeScript type — a separate confirmation, not a duplicate
finding.) Server-side, `grep -rn "set_status(" src/eden --include
"*.py"` finds exactly one caller of `IssuesRepo.set_status`:
`agent_issues.py:174` (`resolve_issue`) — the automation-driven status machine
(`closed_loop/state_machine.py`, `IssueStatus` enum at `:24-36`: `open, triaged,
fix_pending, verifying, resolved, regressed, ignored, learning, escalated` — no
`acknowledged` member anywhere in the codebase, confirming there is no backend
concept this could correctly map to besides the `"triaged"` substitution already
proposed above) writes status via its own `apply_transition`/`_record_transition`
path (`state_machine.py:88-138`), never through `IssuesRepo.set_status`, so it cannot
be affected by or interfere with Bug 8. **Conclusion: "Acknowledge" is the only
silently-no-op status control in the product; Resolve and Reopen are safe today.**

**8d (Phase 4, new, minor) — Reopen never clears `resolved_at`.** `set_status`
(`repo.py:308-332`) only appends `resolved_at = NOW()` when `set_resolved_at=True`,
and `resolve_issue` only passes that when `target == "resolved"` (`agent_issues.py
:392`). The Reopen button calls `onStatus("open")`, which reaches `resolve_issue` with
`target="open"` and `set_resolved_at=False` — `resolved_at` is left at whatever it was
set to the last time the issue was resolved. A reopened issue therefore carries a
stale, misleading `resolved_at` timestamp (issue shows `status="open"` but still has a
historical "resolved at" value that any consumer reading the row directly, e.g. a
regression/SLA report, would misread as "this was resolved and is now open again as of
that old timestamp" rather than "resolution was reverted"). **Fix:** clear it on
reopen: `resolved = ", resolved_at = NOW()" if set_resolved_at else (", resolved_at =
NULL" if status == "open" else "")`.

## Additional lower-severity instance found this pass (same fallback-to-shared-bucket pattern, different field)

`src/eden/insights/detectors.py:187` (`PerformanceAnomalyDetector.analyze`:
`by_version[t.agent_version or "unknown"].append(t)`) and `:262`
(`RegressionDetector.analyze`: `key = (t.agent_version or "unknown",
t.environment_version or "unknown")`) apply the identical "missing value collapses
into a shared literal bucket" pattern to `agent_version`/`environment_version` instead
of `agent_id`. Lower severity than Bugs 4/7 — this feeds a statistical baseline pool
rather than an identity/incident join, and mixing traces with unset version metadata
into one "unknown" baseline is a defensible product choice, not obviously wrong — but
it is the same anti-pattern and worth a follow-up: if two genuinely different
unversioned deployments get pooled, `RegressionDetector`'s Welch's-t-test baseline
comparison is comparing apples to a mixed bag, silently, with no low-sample-size or
mixed-population warning surfaced in the resulting `Insight`.

## Bug 9 (worst finding, promoted Pass 5): the portal's own trace list/detail status
## badge has a second, independent enum-boundary gap — `timeout`/`crash` traces render
## as green/"ok"

**Severity note (Pass 5 synthesis):** promoted to the single worst finding in this doc,
displacing Bug 3 (see Bug 3 §3e). Unlike Bug 3, this bug carries no reachability
caveat: `portal.py`'s `/traces` list and trace-detail routes are the primary,
unambiguously live customer-facing surface, hit on every trace page view for every org,
today. `_map_trace_outcome` has existed since ~2026-07-23 (roughly two weeks before this
review) — a real, current, live bug, not aged debt and not gated behind any dead route.

**File:line:** `src/eden/api/routes/portal.py:177-183` (`_map_trace_outcome`), called
at `:1284` (`GET /traces` list) and `:1464` (trace detail). Contrast with the correct
`_ERROR_OUTCOMES` frozenset defined nine lines below it (`:187-189`).

```python
def _map_trace_outcome(outcome: str | None) -> tuple[str, str]:
    """Return (status, severity) for TraceListItem."""
    o = (outcome or "").lower()
    if o in ("error", "failed", "failure", "fail", "errored"):
        return "error", "error"
    if o in ("warn", "warning", "partial", "degraded"):
        return "ok", "warn"
    return "ok", "none"

_ERROR_OUTCOMES = frozenset(
    {"error", "failed", "failure", "fail", "errored", "crash", "timeout"}
)
```

`_map_trace_outcome`'s error tuple is missing `"crash"` and `"timeout"` — the exact two
values `_ERROR_OUTCOMES` (used at `:460`, `:649`, and inside the same two queries'
`error_detail` SQL `FILTER` clauses at `:1258` and `:1368`) was written to include.
This is a second, independently-introduced instance of Bug 3's dead-condition family,
in the file the doc's own Bug 4/5 findings already flagged as the primary
customer-facing surface — and it's a more directly visible symptom than the RCA
endpoint: both call sites (`:1284`, `:1464`) run the *same query* that already
computes a correct `error_detail` string via `_ERROR_OUTCOMES` for a `timeout`/`crash`
trace, then immediately discard that correctness by passing the raw `outcome` column
through the *wrong* mapping function for the status badge:

```python
status, severity = _map_trace_outcome(row.get("outcome"))   # :1464, also :1284
```

**Concrete, self-contradictory result:** a trace whose only failure is
`outcome='timeout'` shows a green/neutral "ok" badge (`severity="none"`) in both the
traces list and the trace detail header, while the same response payload's
`error_detail` field (populated by the correctly-scoped SQL `FILTER`) may contain an
actual error message — a card that visually says "fine" while displaying error text.

**Fix:** `_map_trace_outcome` should reuse `_ERROR_OUTCOMES` instead of its own
narrower literal tuple:
```python
def _map_trace_outcome(outcome: str | None) -> tuple[str, str]:
    o = (outcome or "").lower()
    if o in _ERROR_OUTCOMES:
        return "error", "error"
    if o in ("warn", "warning", "partial", "degraded"):
        return "ok", "warn"
    return "ok", "none"
```
(Move `_ERROR_OUTCOMES`'s definition above `_map_trace_outcome` or forward-reference
it; both are module-level in the same file.)

## Bug 10 (new, Phase 4): ingestion timestamp normalization silently drops the UTC
## guarantee for one specific input shape, inconsistent with how the rest of the
## codebase treats naive datetimes

**File:line:** `src/eden/observability/ingestion/normalizer.py:32-58`
(`_normalize_timestamp`).

```python
def _normalize_timestamp(value: Any) -> str:
    if value is None:
        return datetime.now(UTC).isoformat()
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=UTC)          # naive datetime -> assumed UTC
        return value.isoformat()
    if isinstance(value, (int, float)):
        ts = value / 1000.0 if value > 1e12 else float(value)
        return datetime.fromtimestamp(ts, tz=UTC).isoformat()   # epoch -> always UTC
    if isinstance(value, str):
        s = value.strip()
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        try:
            datetime.fromisoformat(s)
            return s                                    # naive ISO string -> unchanged, no offset added
        except ValueError:
            ...
```

Three of the four accepted input shapes (`None`, naive `datetime`, epoch number) are
explicitly stamped UTC. The fourth — a string that round-trips through
`datetime.fromisoformat` but carries **no** timezone marker at all (e.g.
`"2026-08-04T10:00:00"`, no `Z`, no `+00:00`) — is returned **unchanged**, with no UTC
assumption applied, purely because it happens to parse. This is the one place in this
audit where a "naive" input is handled inconsistently depending only on its Python
*type* (str vs. datetime), not its meaning.

That unmarked string then flows to `telemetry_collector.py`'s insert-time parse
(`datetime.fromisoformat(str(event.timestamp).replace("Z", "+00:00"))` — repeated at
`:1399`, `:1805`, `:2158`, `:2248`; `TelemetryEvent.timestamp` is typed as a bare `str`
at `:49`), which likewise only special-cases a trailing `"Z"` and never adds an offset
to an already-offset-less string. `datetime.fromisoformat` on a string with no offset
produces a **naive** `datetime`, bound as the `$7` parameter of `TELEMETRY_INSERT_SQL`
(`:289-315`) into the `timestamp TIMESTAMPTZ` column
(`db_migrations/versions/009_telemetry_events.py:39`). A naive value bound to a
`TIMESTAMPTZ` column is interpreted by Postgres according to the connection's session
`timezone` GUC, not guaranteed UTC by the application — silent, environment-dependent
skew if that session setting is ever not UTC.

This is the opposite of the diligence shown elsewhere in the same codebase:
`src/eden/api/routes/portal.py:108-115` (`_iso`) explicitly does
`value.replace(tzinfo=UTC)` for *any* naive `datetime` before serializing a response,
with no type-dependent gap. And on the read side, the portal frontend's relative-time
and chart-date helpers parse whatever string the API returns with the bare JS
constructor — `clients/portal/src/lib/format.ts:7-8`
(`formatRelativeTime`: `new Date(dateString)`) and `:90-92` (`formatChartDate`, same
pattern) — which is safe *only* because `_iso()` is careful to always emit an explicit
offset. Per the ECMA-262 `Date` spec, `new Date("2026-08-04T10:00:00")` (no offset) is
parsed as **local time in the browser's timezone**, while
`new Date("2026-08-04T10:00:00Z")` is parsed as UTC — an eight-hour-plus display error
for a US-Pacific viewer is silent and structurally undetectable from the UI alone.
Today this specific gap requires an ingestion payload (raw HTTP API call, a
third-party webhook provider, or a hand-built test/integration script) to supply an
already-offset-less ISO string — the first-party SDKs and the OTel path (which use
epoch numbers, always-UTC per §Bug 3 audit) don't currently trigger it — but nothing
in `_normalize_timestamp` enforces that invariant, and the inconsistency between the
`datetime`-object branch and the `str` branch of the *same function* is exactly the
kind of latent gap that survives until some client integration changes shape.

**Fix — one line, close the gap at its source:**
```python
if isinstance(value, str):
    s = value.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(s)
    except ValueError:
        logger.debug(f"timestamp not ISO 8601, using now(): {value!r}")
        return datetime.now(UTC).isoformat()
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)   # match the datetime-object branch above
    return parsed.isoformat()
```
This makes all four branches enforce the same invariant ("no timestamp this function
returns is ever timezone-naive") instead of three out of four.

## Not reached / needs follow-up

- Did not confirm whether the fleet-identity drift hook (`agent_intel/performance.py`)
  can fire *because of* the portal registration flow — not re-verified this pass.
- ~~Did not trace whether `_PREFERRED_AGENT_ID_SQL` is applied consistently to the
  `/traces` list and trace-detail endpoints~~ — **resolved this pass**: confirmed
  reused verbatim at `portal.py:954, 1021, 1233, 1343`, i.e. applied consistently
  everywhere agent identity is resolved from telemetry in this file.
- ~~`db_migrations/versions/136_issue_status_escalated.py`'s DB enum ... whether
  `triaged`/`escalated`/`regressed`/`fix_pending`/`verifying`/`learning` are reachable
  through *any* other endpoint~~ — **resolved this pass (§8c/§8d above)**: those six
  values are only ever written by `closed_loop/state_machine.py`'s
  `apply_transition`/`ISSUE_STATE_TRANSITIONS` table, which calls `IssuesRepo.set_status`
  through its own path, not through `resolve_issue`. `resolve_issue`
  (`agent_issues.py:174`) is confirmed to be the *only* caller of `IssuesRepo.set_status`
  reachable from the portal, and the portal only ever sends 3 of its 4
  `_RESOLVE_STATUSES` values (`open`, `acknowledged`, `resolved` — never `ignored`).
- Did not get live database or log access to directly count real-world
  timeout/crash-outcome traces or measure `POST /incidents/cluster` production error
  rates; §3c/§3d above substitute a full ingestion-path trace (SDK / OTel / webhook)
  and migration-history audit for a live count, which is a stronger form of evidence
  for the SQL-crash finding (§3d) specifically, since that one is unconditional
  (schema fact, not data-dependent) rather than probabilistic.
- Bug 10's naive-timestamp-string gap was traced to `_normalize_timestamp` and its
  downstream `TIMESTAMPTZ` binding, but not reproduced against a live Postgres
  instance to confirm the exact session-timezone-dependent behavior (vs., e.g.,
  asyncpg raising outright on a naive-datetime bind to a `timestamptz` column in some
  driver versions) — worth a quick integration-test confirmation before prioritizing
  the fix.

## Verdicts (Pass 5 synthesis — collapses the prior Phase 3 and Phase 4 verdict blocks
## into one; supersedes both)

Methodology across passes: Phase 2's original 7 bugs were independently re-read against
the current working tree in Phase 3 (not trusted from the report text), which
reconfirmed all 7 unchanged (except where noted) and added Bug 8, confirmed end-to-end
from the Python API layer through the Postgres CHECK constraint to the actual portal
TypeScript UI call site. Phase 4 went one layer deeper — tracing every producer of
`outcome` (both first-party SDKs, the OTel adapter, and the webhook/third-party
normalizer) to characterize exactly which real trace populations hit Bug 3, tracing the
SQL candidate-query site all the way to the Postgres schema migration history (which
surfaced the distinct, unconditional §3d bug hiding behind the vocabulary bug's
symptom), auditing every status-transition control reachable from the issues board UI
(§8c), and sweeping for new bug classes (Bug 9, Bug 10). This pass (5, synthesis)
re-ranks severity based on a fact no prior pass checked — live reachability of the RCA
routes (§3e) — and adds one new cross-cutting finding (§3f, `_fetch_trace_events`). No
false positives were found in any pass; every citation below was independently re-read
against the current working tree at least once.

- **Bug 1** — CONFIRMED, unchanged (`components.py:696,772`; `prompt_versioning.py:223,240,242`).
- **Bug 2** — CONFIRMED (upgraded from "likely, unverified" in Phase 2 — independently re-read via `rg`; `components.py:78,93`).
- **Bug 3** — CONFIRMED as a code-correctness bug at every cited site
  (`intelligence_rca.py:68-69`; `_common.py:204,862-870,1002-1011,728-745,992-999`; the
  §3d schema gap at `_common.py:198-213`). New consequence found in Phase 4:
  `_classify_events` (shared by `/analyze` and clustering) reports a genuine
  timeout/crash failure as "no failure detected — trace succeeded." **Severity demoted
  this pass (see §3e, §3f):** the entire `rcaApi` frontend surface that would reach
  `/analyze` and `/incidents/cluster` was deleted from the portal 3 days before this
  review as verified dead code, and no MCP tool or SDK reaches these routes either — so
  today this bug has zero live product blast radius, despite being real,
  well-evidenced, and (per §3d) unconditional. No longer ranked as the doc's worst
  finding — see Bug 9.
- **Bug 4** — CONFIRMED, unchanged (`portal.py:886,929,1063,805-820,1100-1101,1151-1177`); `_PREFERRED_AGENT_ID_SQL` reuse confirmed consistent at all 4 call sites (`:954,1021,1233,1343`). Genuinely live, high-traffic dashboard — unlike Bug 3, no reachability caveat applies.
- **Bug 5** — CONFIRMED, unchanged (`portal.py:941,1076`). Same live-dashboard reachability as Bug 4.
- **Bug 6** — CONFIRMED, unchanged (`signal_investigator.py:248,305`; `investigator.py:363,395`; `084_agent_issues.py:49,93`; zero `agent_id` occurrences in `intelligence_rca.py`). The unvalidated-`agent_id`-on-stumbles half is live (feeds the always-on signal-investigator write path); the `_build_causal_chain`-drops-`agent_id` half feeds `/chain`, which — like Bug 3 — has no portal or MCP caller today (the endpoint was added in the very latest commit touching the file, a fresh gap, not aged debt).
- **Bug 7** — CONFIRMED, unchanged (`clusterer.py:188-189,344-345`; `fingerprint.py:88`; `repo.py:174-176`). Item 1 (the clusterer cluster-key merge) is gated behind the same dead `/incidents/cluster` route as Bug 3 and inherits its reachability caveat; items 2 (`fingerprint.py:88`) and 3 (`repo.py:174-176`) are unaffected and remain live.
- **Bug 8** — CONFIRMED end-to-end: Python API (`agent_issues.py:107-223`) → Postgres CHECK constraint (`136_issue_status_escalated.py:36-64`) → portal TypeScript type + UI call site (`resources.ts:2740-2766`; `issues-client.tsx:496-520`), plus (§8c) a full audit confirming the coercion-target status is the *only* silently-no-op control in the issues board (Resolve and Reopen both send DB-legal values) and (§8d, minor) Reopen leaves a stale `resolved_at` timestamp on the row. 8a is independently corroborated by `bugs/03-api-mcp-contracts.md` (same root cause, that doc's own top-ranked finding); 8c's "no UI path to `ignored`" is independently corroborated by `bugs/04-frontend-and-test-failures.md`.
- **Bug 9** — CONFIRMED: `portal.py:177-183` (`_map_trace_outcome`) omits `crash`/`timeout` from its error check even though the correct set (`_ERROR_OUTCOMES`, `:187-189`) is defined nine lines below it and used by the same two endpoints' (`:1284`, `:1464`) `error_detail` SQL — a second, independent instance of Bug 3's dead-condition family, directly in the portal's primary trace UI. **Promoted to this doc's single worst finding this pass**: no reachability caveat — the portal's `/traces` list and trace-detail routes are the primary, unambiguously live customer-facing surface, hit on every trace page view for every org, today.
- **Bug 10** — CONFIRMED: `normalizer.py:32-58` (`_normalize_timestamp`) stamps UTC onto three of four accepted timestamp input shapes but passes an already-offset-less ISO string through unchanged, unlike the naive-`datetime` branch three lines above it — inconsistent with `portal.py:_iso()`'s unconditional UTC-stamping on the read side and with the portal frontend's bare `new Date(dateString)` calls (`format.ts:7-8,90-92`), which parse an offset-less string as local time per the JS spec.
- **Non-bug, `time_travel/`** — standing from Phase 1, not independently re-verified in Phase 3/4.

**Severity ranking (Pass 5 synthesis — final):**
1. **Bug 9** (worst) — live, current (~2 weeks old), on every trace page view, no reachability caveat.
2. **Bug 4** / **Bug 5** — ghost agent cards / dropped-NULL-`agent_id` rows, both on the same live, high-traffic Agents dashboard.
3. **Bug 8** — highest-confidence bug in the doc (independently corroborated by two sibling review docs), live on the issues board.
4. **Bug 1** / **Bug 2** / **Bug 6** (stumble-write half) / **Bug 7** (items 2–3) — live but narrower or less immediately visible.
5. **Bug 3** / **Bug 6** (`/chain` half) / **Bug 7** (item 1) / **Bug 10** — real, well-evidenced code bugs, but either zero confirmed live reachability today (Bug 3, Bug 6's chain half, Bug 7 item 1 — all gated behind the deleted `rcaApi` surface) or a narrow, unconfirmed-in-practice trigger condition (Bug 10). Worth fixing — cheaply, in Bug 3's case — but not currently product-visible.
