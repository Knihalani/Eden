# Disabled features register

Things that are switched **off** rather than deleted, with the reason and
the exact condition for turning them back on.

The rule that put things on this list: **a feature that reports success
while doing nothing is worse than a feature that is absent.** An absent
feature costs a customer nothing. A lying one costs them their trust and
sends them debugging their own code.

Last reviewed: 2026-08-02.

---

## 1. Time-travel replay — `time_travel_replay_enabled = True` (fixed 2026-07-31)

**Endpoint:** `POST /orgs/{org_id}/intelligence/time-travel/replay`

**Was:** 503 / lying `re_executed=True` with identical hashes (metadata-only
recording; edits applied to step root; empty prompt returned recorded hash).

**Fixed:**
1. AI gateway + HTTP gateway persist capped `prompt` / `messages` in the
   recorded request payload.
2. `_apply_edits_to_step` writes prompt-shaped keys into `payload` and
   `payload.request`.
3. `_re_execute_step` unwraps `payload.request` and returns
   `cannot_replay` / `re_executed=False` when content is missing or the
   gateway fails — callers no longer claim live execution.
4. Default flag is **True**; set `TIME_TRAVEL_REPLAY_ENABLED=0` to disable.
   Historical rows without content still return honest `cannot_replay`.

**Recording** was already ON.

---

## 1b. SSO routes — `sso_enabled = True` (fixed 2026-08-02)

**Fixed.** All 11 handlers in `api/routes/sso.py` were repointed from
the nonexistent `org_sso_providers` to the live schema, verified
against `information_schema` and EXPLAIN-validated (16/16 statements)
against the production database:

- **List/login** JOIN `org_sso_settings` × `sso_configurations`
  (+ LEFT JOIN `org_scim_config` for SCIM status).
- **Create** runs in one transaction: INSERT `sso_configurations`,
  then INSERT `org_sso_settings` referencing it.
- **Update / enable / disable / enforce** write `sso_configurations`
  columns and touch `org_sso_settings.updated_at`.
- **SCIM token generate/revoke** now UPSERT/UPDATE `org_scim_config` —
  the same table `scim.py:157` reads from (mirroring the existing SCIM
  upsert pattern in `orgs.py`), closing the write/read table mismatch
  that made SCIM permanently unconfigurable.

Fields with no live counterpart are handled honestly rather than
silently: `name` is accepted on create but not stored (list returns the
`provider` slug), `default_for_domain` is always `None`, and SAML
`entity_id` / `certificate` / `scopes` are not stored.

`tests/unit/api/test_sso_live_schema.py` exercises a full
create→list round-trip and source-locks the dead table name out of the
module. Routes remounted; default flag is **True**; set
`SSO_ENABLED=0` to disable.

---

## 1c. Signup email verification — `email_verification_enabled = True` (fixed 2026-08-02)

**Fixed.** All three missing pieces shipped together:

1. `email_verification_tokens` table — Alembic migration
   `133_email_verification_tokens` (hash-only storage, mirrors
   `password_reset_tokens`).
2. `send_verification_email` in `email_service.py`, reusing the
   password-reset dispatch fixed 2026-07-30.
3. `POST /auth/verify-email` route — validates the token hash, marks it
   used and sets `users.email_verified = TRUE` in one transaction;
   enumeration-safe; 404 when the flag is off.

Portal page at `/verify-email` (`clients/portal/src/app/(auth)/verify-email/`)
consumes the link. Integration tests
(`tests/integration/test_email_verification.py`) walk one signup through
to a verified login and cover unknown / used / expired tokens plus the
flag-off 404. Default flag is **True**; set
`EMAIL_VERIFICATION_ENABLED=0` to disable.

---

## 2. Right-to-be-forgotten fanout — `rtbf_fanout_v1 = False` (Postgres path fixed 2026-08-02; flag stays off)

**What it is:** GDPR Art. 17 erase (`POST …/rtbf`). Not a free-beta feature.

**Code-fixed 2026-08-02 — what changed in `services/governance_intel/gdpr.py`:**

- **Live-column SQL.** Per-table statements were rewritten against
  `information_schema`: `telemetry_events` is keyed by
  `attributes->>'user_id'` (redacts the JSONB content columns, nulls
  their zstd bytea shadows plus media blobs, strips user-id keys from
  `attributes`); `judge_scores`
  and `conversation_messages` are re-keyed through derived `trace_id` /
  `conversation_id` scopes; `user_feedback`, `user_sessions`,
  `conversations` keep direct user columns.
- **Fail-closed.** The `except … return rows_matched: 0` swallow is
  gone. A SQL error on any table now surfaces in the error envelope with
  the named failing tables — no silent `rows_matched: 0` success.
- **Dead auto-fire deleted.** `promotion_hooks.py`'s compliance-gap hook
  no longer calls `process_request` without `org_id` (it raised into a
  swallowed `except` on every fire). A regression test
  (`tests/intelligence/test_session10_rtbf_hash_ssrf.py`) pins the
  removal. `rtbf_tracker.py:153` still has no production callers.

**Flag stays OFF.** What remains before `RTBF_FANOUT_V1=1` is safe:
secondary-store erasure must be proven real — Typesense, Redis streams,
Qdrant vectors, ClickHouse mirror, S3 media blobs. The Postgres path
now tells the truth; the fanout across the other stores has not been
verified, and enabling without it certifies erasure we cannot perform
there. That is the only remaining blocker.

---

## 3b. Tinybird zero-reader datasource ingest — `tinybird_ingest_unread_datasources_enabled = False` (2026-08-02)

**What it is:** `ClickHouseSink.ingest_agent_traces` / `ingest_pipeline_stages`
/ `ingest_usage_trends` / `ingest_benchmark_results` — the writers for the
`agent_performance`, `pipeline_stages`, `usage_trends`, and
`benchmark_results` Tinybird datasources.

**Why disabled:** Grepped for callers of the four `query_*` helpers and the
four `*_api.pipe` endpoints that read these tables back — zero, in
`src/`, the portal, or any deployed pipe consumer. Grepped for callers of
the four `ingest_*` methods — exactly one, `KafkaEventConsumer.
consume_clickhouse`, and that method is never invoked: it is absent from
`workers/main.py`, `workers/background.py`, and `api/app.py`'s startup
(`app.py` only registers a shutdown hook that closes the singleton *if*
one was ever created). So on Tinybird, every row ever sent to these four
datasources was unpaid storage with nothing ever reading it back, on
either end.

**What changed:** All four `ingest_*` methods return an empty
`IngestionReport` and skip `init_schema()` / the Events API call unless
`tinybird_ingest_unread_datasources_enabled` is `True` (env
`TINYBIRD_INGEST_UNREAD_DATASOURCES_ENABLED=1`). `telemetry_events_ch`
ingest is untouched — it has real readers:

- **Primary (live app):** `ClickHouseSink` `/v0/sql` helpers —
  `query_home_kpis` (Home KPI tiles), plus analytics latency/throughput
  (`query_latency_by_day` / `query_throughput_heatmap` via
  `GET /orgs/{org_id}/analytics/…`).
- **Available pipe (not the primary app reader):**
  `telemetry_events_query_api.pipe` is a raw-row ENDPOINT (filters +
  LIMIT, no percentile/heatmap aggregates). It remains deployable for
  ad-hoc / future wiring; the app prefers `/v0/sql` for aggregates.

**Left in place, not removed:** the four `.datasource` files, the four
`*_api.pipe` endpoints, and `KafkaEventConsumer.consume_clickhouse` all
still exist — each pipe's `DESCRIPTION` now states the same "no reader"
finding and the flag that gates its ingest. Nothing here is a self-hosted
ClickHouse; Tinybird remains the only ClickHouse-compatible substrate.

**Turn back on when:** a real consumer of one of these four surfaces is
built (portal panel, alert rule, etc.) — then re-verify the *other* three
independently before flipping the flag, since it gates all four at once.

---

## 3c. Kafka event-sourcing path — quarantined, not deleted (2026-08 Phase 6)

**What it is:** `eden.realtime.kafka_consumer` (`KafkaEventConsumer`,
`KafkaEventProducer`, `get_kafka_consumer`) and its only downstream caller,
`eden.data_platform.bronze_sink.BronzeEventSink`.

**Why quarantined:** confirmed unreferenced — nothing calls
`get_kafka_consumer()` or starts a consumer loop anywhere in `src/`,
`workers/`, or `api/app.py`'s startup (only a shutdown hook that closes the
singleton *if* one was ever created, per §3b above). `BronzeEventSink.ingest`
in turn has no caller besides `KafkaEventConsumer.consume_bronze`, so it is
transitively dead too. The real, currently-live writer of `usage_events` is
`UsageService.track_events_batch` (raw `executemany`), invoked from
`TelemetryCollector._emit_billing_events` on every ingest batch — a
different, correctly-columned path than either of the above. A stale
comment on `PostgresClient.insert_usage_event` (`storage/postgres.py`)
used to claim `bronze_sink.py` was "the writer that actually runs"; it has
been corrected to name the real one.

**What changed:** no deletion — `kafka_consumer.py` gets a
`NOT WIRED — do not enable` module docstring instead of being moved under
an `experimental/` package, so its existing imports (its own regression
tests in `tests/unit/realtime/test_kafka_consumer.py`, and `app.py`'s
shutdown drain list) don't need touching for a documentation-only change.

**Turn back on when:** a real Kafka producer/topic exists upstream and a
worker entrypoint actually calls `get_kafka_consumer().consume_*`. Re-verify
the DLQ path and the Bronze/Silver/ClickHouse routing logic against the
live topic schema before wiring it — it hasn't been exercised against a
real broker.

---

## 4. Eden MCP server — soft-retired for free beta (F04)

**What it is:** Coding-agent MCP tools (`eden-mcp`, `/v1/mcp`, org MCP keys)
so Cursor/Claude can query traces and trigger autofix from the IDE.

**Why hidden:** Not first-class for free beta. HTTP transport stays
`mcp_http_transport_v1=False`. Org MCP key routes are unmounted.
Portal ⌘K / docs sidebar entry points removed. Code under
`src/eden/mcp_server/` remains for internal/dev.

**Do not confuse with** observe MCP telemetry (customer agents' MCP
tool spans) — that ingest path stays on.

**Re-productize when:** F04 is explicitly back in scope with auth,
portal config UI, and hermetic/autofix tools wired end-to-end.

---

## 5. `eden-worker` Northflank job — `EDEN_RUN_BACKGROUND_WORKERS=0`, now actually enforced

The variable was already set to `0`, but **nothing read it** —
`workers/main.py` mentioned it only in a docstring. The job started the
full fleet whenever it ran, and `runOnSourceChange: cd-promote` runs it
on **every deploy**.

Leader locks and the sidecar guard made that safe rather than correct:
the duplicate process still opened its own 15-connection Postgres pool
against a Neon instance billed for staying awake, still ran the anomaly
and evolution loops (which are *not* leader-gated), and still spent
Upstash commands contending for locks it could never win.

`workers/main.main()` now honours the flag and exits immediately when it
is off. `--once` is exempt (local dev / tests). Absent or empty means
enabled, so existing deployments are unchanged.

The job is kept as a break-glass host: set the variable to `1` and
trigger a run if the API service is ever unable to carry the fleet.

---

## Out of scope (intentionally not built)

**On-call schedules, rotations, ack/snooze UI, SLA escalation timers** — Eden
integrates with external on-call tools instead; see
[on-call-scope-decision.md](../specs/strategic-review-2026-08/features/on-call-scope-decision.md)
(FEAT-105). `AlertRule.auto_escalate` / `escalation_delay_seconds` in
`alert_stream.py` are inert by design, not disabled stubs.

---

## Deliberately NOT disabled

**Background workers on `eden-api`.** Turning them off would take Neon
to ~2-5 compute-hours/month, but it also stops webhook delivery, EQL
alerts, the quality pipeline and the closed loop. Not a launch-day
trade.

**Neon scale-to-zero tuning.** The measured levers below would take Neon
from ~220 to ~20 compute-hours/month and put the Free tier in reach,
worth about **$19/month**:

| lever | now | proposed |
|---|---|---|
| `redis_leader_tick_seconds` | 120 | 600 |
| `idle_poll_period_seconds` | 600 | 3600 |
| PG-lease renewal cadence | raw sub-TTL interval | `next_grid_delay()` |

They are **not applied**, on purpose. Scale-to-zero means the first
request after an idle period pays a cold start, and during live demos a
warm database is worth more than $19/month. Revisit once the demo period
is over.

What *was* applied is the piece with no demo risk:
`self_obs_probe_interval_seconds` 600 → 3600. Self-observability was
**95.2% of all database writes** at zero users (19,576 of 20,553
inserts; everything else combined was 977 rows). That is now ~1,387
rows/day instead of ~8,321, at the cost of a degraded component paging
up to an hour later — which at launch scale you would notice from the
portal first anyway.
