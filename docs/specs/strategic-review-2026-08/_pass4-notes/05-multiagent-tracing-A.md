# Pass 4 notes — 05-multiagent-tracing.md (sole reviewer)

Scope: re-verify every non-trivial claim in the pass-3 doc against current source, prune
false/redundant/filler content, and draft a grounded "User Experience & Value" section. The
original doc is untouched; this file is my working record + deliverable for the editor who
folds it back in.

Bottom line: **the pass-3 doc holds up.** Every internal-source claim I re-checked (dataclass
fields, SQL text, migration DDL, route wiring, portal grep, line numbers) is accurate down to
the cited line number. I found zero false claims. I did find one claim that's now *technically*
imprecise (a "zero hits" grep that returns one hit — a regression test, which if anything
strengthens the point) and several new, more damaging findings one layer downstream of what the
doc already covers — specifically in the portal's actual per-span rendering path, which the doc
gestures at (`get_trace_tree`'s node dict) but doesn't trace all the way to what the browser
receives.

---

## VERIFIED

All confirmed by direct read/grep against the current tree, not by trusting the doc's prior
citations:

- **`TelemetryEvent` dataclass has no OTel/A2A fields.** `src/eden/observability/telemetry_collector.py` —
  `to_dict()` (:102–142) and `from_dict()` (:145–185) enumerate the same ~30 fields; neither
  contains `operation_name`, `provider_name`, `error_type`, `parent_agent_span_id`, or
  `child_agent_trace_id`. Confirmed by full read, not grep-absence.
- **`otel_exporter.py`'s operation-name map exists and is narrow.** `_OPERATION_NAME_MAP`
  (`src/eden/observability/otel_exporter.py:36-49`) has exactly 12 entries, all LLM-call event
  types (`openai.chat_completion`, `anthropic.message`, etc.) mapping mostly to `"chat"`. No
  entry for `tool.call`, `span.start`, or `env.step`, confirming the doc's claim it would
  mislabel tool/agent-boundary spans if reused verbatim.
- **`gen_ai.conversation.id` fabrication confirmed at the cited line.**
  `otel_exporter.py:264`: `add("gen_ai.conversation.id", event.trace_id)`. `_event_to_otlp_span`
  starts at :201, `operation = _OPERATION_NAME_MAP.get(...)` is at :238 — both line numbers the
  doc cites are exact.
- **`get_trace_tree`'s node dict has `error_type` with no fallback, and no `agent_id` key.**
  `telemetry_collector.py:1848` (`def get_trace_tree`), node dict at :2053–2094 includes
  `"error_type": row.get("error_type")` verbatim with no `COALESCE`/JSONB fallback, and no
  `"agent_id"` key anywhere in that dict. Full-file grep for `"agent_id"` hits only the
  dataclass `to_dict`/`from_dict` (:111, :154) and an unrelated ClickHouse row-builder in
  `_route_clickhouse` (:1582) — never the tree-node builder. Matches the doc exactly.
- **`portal.py:1385` calls `get_trace_tree`.** Confirmed:
  `return await collector.get_trace_tree(org_id, trace_id, hydrate_bodies=False)`.
- **The broken `_fetch_handoff_counts_in_window` query, line-for-line.**
  `src/eden/agents/agent_intel/_common.py:383-398` is exactly the cited SQL: `FROM
  telemetry_events WHERE org_id = $1 AND parent_agent_id IS NOT NULL ...`. Both columns are
  undefined on `telemetry_events` (which has `tenant_id`, not `org_id`, per the
  `TelemetryEvent` dataclass; and `parent_span_id`/`parent_agent_span_id`, never
  `parent_agent_id`, per migration 058). The `except Exception` at :401-403 swallows the
  Postgres `UndefinedColumnError` and returns `[]` silently — this function can never return
  real data as written.
- **Migrations 058/066/067, exactly as cited.** `058_a2a_links.py` adds
  `parent_agent_span_id`/`child_agent_trace_id` (UUID) to `telemetry_events` (:22-24 DDL
  comment, :78/:82 real `ADD COLUMN`). `066_session21_indexes.py` is titled "Session 21 tenant +
  agent + recency indexes" — confirmed it's an unrelated index migration, not the OTel columns
  work. `067_trace_quality_otel_columns.py` adds 12 columns including `usage_prompt_tokens`,
  `usage_completion_tokens`, `usage_total_tokens` (:77-85, legacy OpenAI naming, not OTel's
  `gen_ai.usage.*`) and `finish_reason VARCHAR(32)` (:93); `downgrade()` at :140 does
  `DROP COLUMN IF EXISTS finish_reason` even though `finish_reason` was actually added by
  `011_capture_full_payloads.py:63` (`VARCHAR(64)`) — 067's own `ADD COLUMN` at :93 was a
  silent no-op against a pre-existing column of a *different width* (64 vs 32), and its
  downgrade would destroy live data 067 never owned. All line numbers match the doc exactly.
- **`FleetService.refresh_delegation_edges`/`delegation_graph`, end to end.**
  `src/eden/fleet/service.py:128` (`refresh_delegation_edges`) rebuilds
  `agent_delegation_edges` from a 7-day `a2a_links` window; `:404`
  (`delegation_graph`) calls it inline and returns
  `{nodes: [{id, label, delegation_trust}], edges: [{source, target, call_count_7d,
  error_rate_7d, delegation_trust, blast_radius}]}`. Route confirmed:
  `src/eden/api/routes/fleet.py:60-62`, `GET /delegation`, gated on `_FLAG =
  "fleet_health_v1"`. `config.py:1450`: `fleet_health_v1: bool = True` — live default, not
  dark-launched. All accurate.
- **Frontend has zero real consumers of any `FleetHealthService` endpoint** — see NEW FINDINGS
  below for a sharper version of this with a second, independent piece of evidence.
- **`/fleet` is a coded redirect, not an unbuilt route.**
  `clients/portal/src/lib/stub-try-instead.ts:26`: `"/fleet": { href: "/agents", label:
  "Agents" }`. No `clients/portal/src/app/(portal)/fleet/` directory on disk.
  `portal-routes.ts:20` still lists `"/fleet"`; `portal-polish.ts:175` still references
  `"app/(portal)/fleet/page.tsx"` — both stale relative to the redirect, as the doc says.
- **`agents-client.tsx`'s `fleetOpen`/`fleetGroups` state, exact range.**
  `clients/portal/src/app/(portal)/agents/agents-client.tsx:818-819` declares `fleetOpen`
  (`usePersistentBool("eden.agents.fleetOpen", ...)`), `:865` declares `fleetGroups`, and both
  are referenced through :1032 — the doc's cited `:818-1032` range is exact, and it is purely
  client-side grouping, unconnected to `FleetService`.
- **`sdk/a2a.py`'s `_A2ACallCtx.attributes()`, exact range and behavior.**
  `src/eden/sdk/a2a.py:114-129` returns
  `{"parent_agent_span_id": ..., "child_agent_trace_id": ..., "a2a": {"invocation_type":
  ..., "parent_agent_id": ..., "child_agent_id": ..., "response_status": ...}}` — a dict meant
  to be merged into the JSONB `attributes` blob only; nothing reads it back onto real
  `TelemetryEvent` columns anywhere (consistent with finding 1: those columns don't exist on
  the dataclass yet).
- **Ingestion's `agent_id` header-stamping, exact range.** `src/eden/api/routes/ingestion.py:317-332`
  resolves `agent_id` from `X-Eden-Agent-Id`/`X-Agent-Id` headers (falling back to
  `X-Project-Id`) and stamps it onto events missing it. Matches doc's cited anchor point for
  where the fix would slot in.
- **`sessions/rollup.py` and `llmops/insights_tools.py` COALESCE claims.** `rollup.py:57-71`
  is exactly the `COALESCE(NULLIF(payload->>'input_tokens',''), usage_prompt_tokens, 0)`
  block the doc describes (JSONB-first, column-fallback) — but `rollup.py:57` itself,
  `max(error_type) AS error_type`, has **no such fallback**, and `llmops/insights_tools.py:342-344`
  has the equivalent `COALESCE(usage_prompt_tokens, (payload->>'input_tokens')::numeric, 0)`
  pattern for tokens. Both citations check out exactly.
- **External spec claims (OTel GenAI, A2A) — not re-fetched this pass.** Pass 3 already
  fetched these directly from `open-telemetry/semantic-conventions-genai` and
  `a2a-protocol.org` (per its own "fetched directly... not paraphrase" framing and specific
  attribute/field enumerations). Re-fetching a third time has low marginal value against this
  pass's mandate to re-verify *internal* source claims; I did not find internal evidence
  contradicting any of the spec claims, and the task's own instruction is to check
  "eden lacks X" claims against `KNOWN-SUBSYSTEMS.md`, which these aren't (they're about
  external standards, not eden's own subsystem inventory).

## CUT

1. **Quote:** the entire "Appendix: prior-pass text — kept for audit trail" section (both the
   "Second-pass summary" and "First-pass summary" subsections, doc lines ~111-118).
   **Reason:** redundant. Every substantive fact in both superseded summaries (the broken
   query, the four subsystems, the unwired migrations, the `parent_span_id` vs
   `parent_agent_id` correction) is already restated — more precisely, with exact line numbers
   — in the current pass's "What eden actually has" and "Fact-check corrections" sections. This
   is pass 4, the final pass; carrying two more paragraphs of now-strictly-subsumed narrative
   forward adds length without adding information. The doc's own convention elsewhere
   ("Sections on LangSmith/LangGraph... are unchanged from pass 2 and are not re-litigated
   here; see git history for that text if needed") already establishes that superseded content
   belongs in git history, not inline — this appendix should get the same treatment.

2. **Quote:** "## Fact-check corrections from the prior draft (this pass)" section in full
   (5 bullets, doc lines ~83-90).
   **Reason:** near-total duplicate of content already stated, at greater precision, in "How
   competitors/standards represent this" and "What eden actually has" above it. E.g. the "18
   values not 4" correction is already the lead bullet of the OTel section; the ingestion
   write-gap root-cause is already finding #1 in "What eden actually has"; the `error_type`
   fallback gap is already finding #4; the `/fleet` retirement is already spelled out in the
   `FleetService` section; the A2A spec-field comparison is already in the A2A bullet above.
   Recommend cutting this section entirely rather than trimming it — it was useful scaffolding
   *while drafting* pass 3 (to make sure corrections got captured) but now only exists to
   restate the same five facts a second time in a different shape.

No claims were found to be false, unverifiable, or speculative on this pass — the doc's own
fact-checking discipline (line-anchored, "traced to source not inferred") held up under
independent re-verification. The two cuts above are pure redundancy trims, not correctness
fixes.

## USER EXPERIENCE & VALUE

**What debugging a multi-agent trace looks like in eden today.**

An engineer gets a `trace_id` (from an alert, a user report, or the traces list) and opens the
portal trace-detail view. That view is served by `GET /orgs/{org_id}/traces/{id}` in
`src/eden/api/routes/portal.py:1320`, which calls `TelemetryCollector.get_trace_tree`
(`telemetry_collector.py:1848`) and flattens the resulting span tree into a list of
`TranscriptStep` objects (`_flatten_tree`, `portal.py:788`, via `_tree_node_to_step`,
`portal.py:637`). This is the "run transcript" the engineer actually reads.

Three things are true about that transcript, verified directly against
`TranscriptStep`'s schema (`src/eden/api/portal_contracts.py:78-97`) and its construction:

1. **No span carries an agent identity.** `TranscriptStep` has `id`, `spanId`, `parentId`,
   `model`, `provider`, `tokensIn/Out`, `costUsd`, `attributes`, previews, `errorMessage` — no
   `agentId` field exists on the model at all, and `_tree_node_to_step` (`portal.py:637-782`)
   never references `node.get("agent_id")` even to stuff it into the generic `attributes` bag —
   confirmed by grepping the whole function body for "agent" (zero hits). Compare this to
   `TraceListItem`, the *list*-level row one level up, which does have `agentId: str = ""`
   (`portal_contracts.py`) — but it's populated by `_PREFERRED_AGENT_ID_SQL`
   (`portal.py:804-816`), a `COALESCE`/`ARRAY_AGG` that picks **one** agent id to represent the
   *entire trace*, explicitly filtering out framework-prefixed ids (`pydantic-ai:%`,
   `langchain:%`, `langgraph:%`, `crewai:%`, etc.) to prefer a "real" one. So a trace spanning
   three agents shows up in the trace list labeled with a single agent name, and once you open
   it, that label disappears entirely — every span in the transcript looks identical in origin.
   Today, the only way to tell which agent produced which span is to notice a discontinuity in
   `model`/`provider`/naming conventions in the span titles, or to go around the portal
   entirely and query `telemetry_events.agent_id` directly.

2. **The one piece of real agent-linkage data that *is* attached to a span is stripped before
   it reaches the browser.** When a caller uses the A2A SDK wrapper, `_A2ACallCtx.attributes()`
   (`sdk/a2a.py:114-129`) merges `{"parent_agent_span_id": ..., "child_agent_trace_id": ...,
   "a2a": {"invocation_type": ..., "parent_agent_id": ..., "child_agent_id": ...,
   "response_status": ...}}` into the span's JSONB `attributes`. But `_tree_node_to_step`
   builds the step's outgoing `attributes` field via
   `safe_attrs = {k: v for k, v in attrs.items() if isinstance(v, (str, int, float, bool))} or
   None` (`portal.py:752`) — a scalar-only filter. The nested `"a2a": {...}` sub-document,
   which is the one part of this payload with human-readable agent ids and an explicit
   invocation type, is silently dropped by that dict comprehension; only the two flat UUID
   strings (`parent_agent_span_id`, `child_agent_trace_id`) survive, unlabeled, inside a
   generic key-value bag the frontend renders as raw JSON with no cross-reference back to the
   span or trace they point at. An engineer who does think to open a span's raw attributes and
   spot a stray UUID has no click-through to "go to that span" — they'd have to copy the UUID
   into a manual trace lookup.

3. **There's no visual vocabulary for "this is an agent boundary."**
   `TranscriptKind = Literal["task", "llm", "tool", "bash", "span"]`
   (`portal_contracts.py:21`) is the exhaustive set of step kinds `_step_kind` (`portal.py:444`)
   can assign — there is no `"agent"` or `"handoff"` kind. Once `operation_name` is wired end to
   end (the doc's own recommended fix), an `invoke_agent`-kind span would still render as an
   undifferentiated `"span"` unless this enum and `_step_kind`'s mapping logic are extended too
   — a gap one layer past what the doc's migration/insert diff already covers, worth folding
   into the same portal follow-up work.

**What it should look like** (grounded in what's already computed correctly server-side, not
generic tracing-vendor language):

- **Swimlane the transcript by agent, not just by parent/child span nesting.** The trace tree
  already walks `parent_span_id` correctly for intra-agent nesting; the only missing input is
  `agent_id` on each `TranscriptStep`. This is close to free once `get_trace_tree`'s node dict
  carries `agent_id` (doc's own recommended fix, item 5 in the migration diff) — the portal
  change is then: add `agentId` to `TranscriptStep`, populate it in `_tree_node_to_step` from
  `node.get("agent_id")`, and group/color the existing flat list by that field. No new backend
  work beyond what's already scoped.
- **Render agent-to-agent handoffs as a distinct, labeled event, not a buried UUID pair.**
  Surface the `a2a` sub-document (`invocation_type`, `parent_agent_id`, `child_agent_id`,
  `response_status`) as a first-class transcript marker — e.g. a `"handoff"` `TranscriptKind` —
  instead of letting the scalar-only `safe_attrs` filter erase it. Concretely: stop discarding
  nested dicts wholesale in `safe_attrs` and special-case `attrs.get("a2a")` the same way
  `model`/`provider` are already special-cased elsewhere in `_tree_node_to_step`.
- **Give the failure a causal chain, not just a red dot.** When a child agent's span errors,
  the engineer should be able to walk backward through `parent_agent_span_id` /
  `a2a.parent_agent_id` to see *which* agent's delegation produced the failing call, and
  whether that parent agent then also failed as a consequence — i.e. the blast radius within
  one trace, not just the aggregate blast radius `FleetService.delegation_graph` already
  computes org-wide (`_delegation_trust_score`, `fleet/service.py:404-443`) but which has no
  portal surface at all (see NEW FINDINGS — this is *more* unwired than the doc's "zero hits"
  phrasing suggested, not less).
- **Filter/search a trace list by agent identity, not just by the one collapsed "preferred"
  agent per trace.** Today `_PREFERRED_AGENT_ID_SQL` deliberately picks a single winner per
  trace for the list view; there's no query path that says "show me every trace where agent X
  participated, even as a sub-delegate." That requires either exploding the collapse (list
  `agent_id` as an array per trace) or exposing a secondary "participants" facet — a materially
  different query shape from what exists, and worth scoping as its own follow-up rather than
  folding into the transcript-rendering fix above.
- **Put the org-wide delegation graph somewhere a human will find it.** The backend
  (`delegation_graph()`) is correct and self-refreshing; the fix is presentational, not
  algorithmic — a panel on the existing `agents-client.tsx` detail pane (the doc's own
  recommendation), populated by a single already-correct `GET
  /orgs/{org_id}/fleet/delegation` call. This is the cheapest of the four gaps to close because
  none of the hard graph-computation work remains to be done.

None of this requires new tracing infrastructure or a new data model. Every gap listed above is
a *rendering* or *field-plumbing* gap sitting on top of computation that already exists and
is, per the verification above, already correct — which is the same "half-finished, not
never-started" shape the rest of the doc documents at the ingestion-write-path layer.

## NEW FINDINGS

1. **The portal's actual per-span step schema (`TranscriptStep`) is a stronger, more concrete
   version of the doc's `get_trace_tree` finding.** The doc stops at "the tree-node dict has no
   `agent_id` key." One layer further downstream, `TranscriptStep`
   (`src/eden/api/portal_contracts.py:78-97`) — the schema the portal frontend actually
   consumes — has no `agentId` field in its type at all, and its constructor
   (`_tree_node_to_step`, `portal.py:637-782`) never references agent identity in any form.
   Separately, the one piece of real per-span agent-linkage data that does exist in JSONB
   (`sdk/a2a.py`'s nested `"a2a": {...}` sub-document) is actively stripped by
   `safe_attrs = {k: v for k, v in attrs.items() if isinstance(v, (str, int, float, bool))}`
   (`portal.py:752`) before the API response is built — a second, independent reason (beyond
   the write-path gap) that today's UI cannot show agent boundaries within a trace, even for
   the subset of traffic already using the A2A SDK wrapper correctly.

2. **`_fetch_handoff_counts_in_window`'s "two sibling-query victims"** (referenced but not
   detailed in `KNOWN-SUBSYSTEMS.md`) **are identifiable and both share the same undefined-`org_id`-on-a-`tenant_id`-table
   bug, in the same function.** `_fetch_telemetry_rollup_for_agent`
   (`src/eden/agents/agent_intel/_common.py:238-340`) fires three queries in parallel via
   `asyncio.gather`: `_telemetry_rows()` (`:291-299`, `FROM telemetry_events WHERE org_id =
   $1` — broken, same bug) and `_judge_rows()` (`:325-333`, `FROM judge_scores WHERE org_id =
   $1` — also broken; `judge_scores.tenant_id` is the real column per
   `010_judge_scores.py:32`, confirmed no `org_id` column exists). Only `_cost_rows()`
   (`:307-315`, `FROM usage_events WHERE org_id = $1`) is actually correct, because
   `usage_events` genuinely uses `org_id` (confirmed by `066_session21_indexes.py`'s own
   2026-07-03 audit note explaining a prior crash from assuming `tenant_id` there). Net effect:
   every call to this rollup silently returns `n_traces: 0, success_rate: None, judge_avg:
   None` for the telemetry- and judge-derived fields — only `cost_usd` is ever real — with no
   error surfaced anywhere (`except Exception: logger.debug(...)` on each of the three
   sub-fetches). This is a concrete, worse-than-stated instance of the same root problem the
   doc already flags, now with exact line numbers for both siblings.

3. **`sessions/rollup.py`'s `_turn_errored()` has a permanently-dead branch as a direct
   consequence of the `error_type` write-path gap.** `src/eden/sessions/rollup.py:137-140`:
   `def _turn_errored(row): return bool(row["error_type"]) or outcome in _ERROR_OUTCOMES`. Since
   `error_type` has never been written on ingestion (same root cause as finding #1 in
   `KNOWN-SUBSYSTEMS.md`), `bool(row["error_type"])` is always `False` — session-level error
   detection today runs entirely on the `outcome in _ERROR_OUTCOMES` fallback, with the
   `error_type` half of the `or` silently dead. Not multi-agent-specific per se, but it's a
   second live consumer (beyond `get_trace_tree`'s portal node) of the same permanently-null
   column, worth citing alongside the doc's existing `error_type` finding as evidence of blast
   radius.

4. **The doc's "zero hits total" grep claim is now technically imprecise — and the correction
   makes the underlying point stronger, not weaker.**
   `grep -rn "orgs.*fleet|fleetApi|/fleet/summary|/fleet/heatmap|/fleet/sla-breaches|/fleet/delegation"
   clients/portal/src` returns **one** hit today, not zero:
   `clients/portal/src/lib/api/__tests__/dead-code-removal.test.ts:32`, which lists
   `"fleetApi"` inside `deletedNamespaces` — an array of `*Api` namespace names a regression
   test asserts stay deleted from `resources.ts`. That test file's own docstring:
   *"Portal prune: zero-consumer `*Api` namespaces removed from `resources.ts`; domain facade
   barrels deleted."* `"a2aApi"` is in the same deleted-namespaces list (line 20), directly
   relevant to the doc's separately-mentioned "a2a BFS endpoint" portal gap. This is
   *stronger* evidence than a bare zero-hits grep: it shows the frontend team explicitly
   identified `fleetApi` (and `a2aApi`) as zero-consumer and deleted them on purpose, with a
   standing regression guard to keep them deleted — i.e. this isn't an oversight the frontend
   hasn't gotten to, it's a decision that was made and then locked in, which the doc's proposed
   "add a Delegation panel to `agents-client.tsx`" fix would need to work with/reverse rather
   than just "fill a gap."

5. **Migration-numbering hygiene note, not a functional bug:** there are two distinct `135_*`
   migrations on disk — `135_loop_events_outbox.py` and `135_webhook_deliveries_last_attempt.py`
   — a duplicate revision number. Doesn't affect the doc's "next unused number is 143" claim
   (142 remains the true highest sequential number,
   `db_migrations/versions/142_session_summaries.py` confirmed latest), but is worth a one-line
   mention if this doc's migration-diff section gets implemented literally, since whoever picks
   the next number should know duplicate numbering has happened before in this migration
   directory and isn't caught by tooling.
