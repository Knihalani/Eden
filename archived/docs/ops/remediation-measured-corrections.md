# Measured corrections to the remediation plan

Every performance claim in the original audit was re-measured before being
acted on. Roughly half did not survive contact with a measurement. This file
records the numbers so the corrected figures are what gets quoted, and so the
same claims are not re-litigated from the original document.

Method throughout: best-of-5 medians, realistic payload shapes, and for
ClickHouse a real server (24.3.18.7) rather than a mock.

## Corrected downward

**Response class: ~1.1x, not 50.4x or 4.9x.** orjson's render really is
3.76-4.31x faster than stdlib, but FastAPI's `serialize_response` calls
`jsonable_encoder` unconditionally and that costs **~7x the render it feeds**
(10.9ms vs 1.5ms on a 213.7 KiB response). So replacing `render()` moves the
total by ~10%. Still worth doing — it is free, and `jsonx` sets
`OPT_NON_STR_KEYS` where the stock `ORJSONResponse` does not, which is a
correctness fix for int/UUID-keyed dicts. The remaining 24.9x is real but
requires bypassing the encoder per-endpoint, which forfeits `response_model`
validation.

| payload | jsonable_encoder | stdlib render | jsonx render |
|---|---|---|---|
| 1.2 KiB | 61 us | 10.5 us | 2.4 us |
| 26.8 KiB | 1363 us | 193 us | 50 us |
| 213.7 KiB | 10922 us | 1495 us | 398 us |

**ClickHouse compression: 14.05x, but only on prose-shaped data.** The plan's
14.9x is close for realistic payloads and badly wrong for incompressible ones.
Quote the range, not the number.

| | ZSTD(3) vs LZ4 | unread blobs' share of table |
|---|---|---|
| prose-shaped | 5.29x | 58.5% |
| high-entropy (worst case) | 1.21x | 97.7% |

**`to_thread` for PII masking: 3.1x on stall, 1.0x on throughput.** `re` does
not release the GIL, so this is not the clean offload it appears to be. On a
512 KiB body: wall time 96.5ms inline vs 96.8ms threaded (unchanged), worst
event-loop stall 96.2ms vs 30.7ms. Describing it as "moved off the event loop"
would be false; the GIL is released between the fourteen `re.sub` calls but held
for the duration of each.

**Async gzip in the TS SDK: rejected as a pessimization.** `gzipSync` at level 1
costs 0.4ms for a 621KB body (~0.5ms/MB). The async form was ~40% slower in wall
clock (11ms vs 8ms over 20 calls) for the threadpool round-trip, to hand back a
fraction of a millisecond of event loop. Capping the batch at `maxBatchSize`
removed what little motivation existed. Revisit only above ~20MB bodies, where
the stall reaches ~10ms.

## Corrected upward — worse than described

**PII masking is ~188 us/KiB and linear.** 6ms at 32 KiB, 96ms at 512 KiB, and
it runs inline: all twelve `_emit_gateway_telemetry` call sites `await` it before
returning the response. On 128 KiB of ordinary prose **all 14 patterns scanned
the full text and none matched** — the entire 23.8ms found nothing. A literal
prefilter for the three patterns with a mandatory substring brings it to
157 us/KiB, proven byte-identical over 20k adversarial inputs. The expensive
patterns (phone 3.6ms, ssn 2.4ms, ipv4/6 2.3ms each, credit_card 2.0ms — 12.6ms
of the 23.8ms) have no such literal and were deliberately left alone: a looser
prefilter there is a PII leak, not an optimisation.

**The clusterer fan-out had no upstream bound at all.**
`_fetch_failed_traces_in_window` carried no `LIMIT`, and every returned trace
became one concurrent Postgres read. A tenant with 50,000 failed traces in the
window issued 50,000 simultaneous reads, exhausting the shared pool and stalling
**every other tenant's requests**. The plan described this as a missing
concurrency cap; the missing `LIMIT` was the larger half.

**`bounded_create_task` leaked the request-pinned connection.**
`copy_context_without_request_pg_conn` documents the cross-tenant hazard in
detail but only `webhook_delivery` ever called it. Every other fire-and-forget
site used a plain `loop.create_task` and inherited the binding. Verified: a task
awaited after the request ended still saw the pinned connection object, which
the pool may by then have handed to a different tenant.

## Claims that were about something else entirely

**The ClickHouse subsystem had never executed a statement.** `_execute` passed
its SQL as form-encoded body data; ClickHouse reads the body *as SQL* and
answered `Code: 62. Syntax error: failed at position 1 ('query')` to everything,
including `SELECT 1`. Fixing the transport then exposed two further defects that
were unreachable behind it — `TTL` on a `DateTime64(3)` column
(`BAD_TTL_EXPRESSION`, four tables) and `avgState` over a `UInt32` column
(`CANNOT_CONVERT_TYPE`) — plus a headerless read format that made `_parse_tsv`
return empty for single-row results. Six of eight `_parse_tsv` call sites never
requested `TabSeparatedWithNames`; the two that did are why it looked healthy.

**Rollup aggregates were wrong by a factor of the ingest block count.** Three
`SummingMergeTree` tables stored averages and percentiles as plain `Float64`;
that engine collapses same-key rows by *adding* every non-key numeric column.
Measured with 1000 events over 10 insert blocks: true avg 201.1ms stored as
2010.9ms, true p95 290ms stored as 2888.6ms. `OPTIMIZE FINAL` reproduces it
exactly, because the merge is what does the summing.

## Found while checking my own reasoning

**RLS is not currently enforcing anything against Eden's own queries.** No table
uses `FORCE ROW LEVEL SECURITY`, no migration creates a separate application
role, and there is not one `GRANT` statement in the migration chain — so Eden
connects as the table owner, and `ENABLE ROW LEVEL SECURITY` does not apply to
the owner. Tenant isolation rests entirely on the explicit
`WHERE tenant_id = $1` predicates in application SQL. The ~20 policies are
real but inert for the app role.

This is not something to "fix" casually: adding `FORCE` plus a non-owner role
would immediately make every unpinned read return zero rows, which is the
failure mode the plan already flags as silent. It is recorded here so nobody
assumes the database is backstopping the application's WHERE clauses.

**The `OR current_setting(...) IS NULL` escape hatch does not fire on a recycled
connection.** Verified on PostgreSQL 16: the middleware sets the GUC with
`set_config(..., true)` (transaction-local), and once a placeholder GUC has been
assigned in a session it reverts to `''` — not to unset — after commit.

| session state | `current_setting('app.current_org_id', true)` | `IS NULL` branch |
|---|---|---|
| never assigned | NULL | fires |
| inside `SET LOCAL` | the org id | n/a, equality fires |
| **after commit** | `''` | **does not fire** |

So migration 002/123's escape hatch only admits a connection that has never
served a request. Preserving it was still correct — dropping it would have
broken the never-assigned case, which is what `bronze_sink` uses — but it is
narrower protection than the comment there implies.

## Notes on method

Two mistakes worth not repeating.

`AggregatingMergeTree` collapses *non-aggregate* columns to an arbitrary value,
so leaving `event_count` as a plain `UInt64` reported 500 of 1000 events. Counts
need `SimpleAggregateFunction(sum, ...)`. Caught by running the probe, not by
review.

`ruff` reports syntax errors as `invalid-syntax` with no rule code, so a
`grep -oE "[A-Z]+[0-9]+"` filter over its output silently hides them — a real
`IndentationError` was reported as "clean". Compare lint against HEAD by reading
old versions with `git show HEAD:path` into a temp tree; a `git stash`-based
comparison with a long file list can fail on a truncated pathspec, and a
follow-up `pop` chained with `;` will then target whatever stash happens to be
at the top — including another agent's.

## `copy_records_to_table` is the wrong tool for the ingest batch write

The plan called for `copy_records_to_table` on the ingest path ("greenfield").
Measured against a table with `telemetry_events`' shape and the same
`ON CONFLICT (event_id, timestamp)` conflict target, on local Postgres 18 over
a unix socket, one transaction per batch:

| strategy | 10 events | 50 | 200 |
|---|---|---|---|
| N serial `INSERT` (current) | 100.3 µs/ev | 60.8 | 60.2 |
| `executemany` | **29.3** | **23.7** | **22.6** |
| one multi-row `VALUES` | 30.4 | 23.3 | 35.3 |
| `COPY` → temp → `INSERT SELECT` | 150.7 | 40.4 | 25.0 |

`COPY` is **slower than what it would replace** at batch 10 (0.67×) and never
beats `executemany` (2.41× vs 2.67× at 200). The reason is structural, not
tuning: `COPY` has no `ON CONFLICT`, and the write must stay idempotent because
the SDK retries on 5xx and `ingest_batch`'s partial-failure handling depends on
re-sends not double-counting. So `COPY` requires a temp table plus a second
pass, and that fixed cost dominates at realistic batch sizes.

`executemany` wins at every size (2.56–3.42×), needs no new machinery —
`PostgresClient.executemany` already exists — and the advantage should widen on
the production DSN, since its edge is round-trip count and Neon over TLS pays
far more per round trip than a unix socket does.

Multi-row `VALUES` matches `executemany` for small batches but degrades at 200
(1.71×) as the parameter count grows.

## The ingest path was losing whole batches under RLS

Not a correction to a number — a bug the plan did not anticipate, found while
implementing the RLS lazy lease.

asyncpg permits exactly one operation in flight per connection: 8 concurrent
statements on one connection, 7 raise `InterfaceError: cannot perform
operation: another operation is in progress`. `RLSOrgContextMiddleware` pins one
connection per request and `PostgresClient.acquire` hands it to every caller in
that request's context. `TelemetryCollector.ingest_batch` gathers one `_route`
per event, and `_route` gathers six sinks — so a 10-event batch issued 10
concurrent INSERTs against one connection. Nine collided,
`_route_postgres` wrapped the failure in `IngestionUnavailable`, and
`ingest_batch` re-raised it, so the **whole batch 503'd** and the SDK's retry hit
the same wall.

Reachable through the documented setup: `X-Org-Api-Key` + `X-Org-Id` is a
verified identity, so `_resolve_org_id` returns the header org and a connection
is pinned; the TS SDK sends `X-Org-Id` whenever `orgId` is configured. Fixed by
serialising use of the pinned connection (`RequestConnLease.use`, reentrant per
task). Falling through to an unpinned pool connection instead would look
cheaper, but migration 124 adds `WITH CHECK` to all 20 policies and a
`WITH CHECK` against an unset GUC rejects the INSERT — that would trade this
failure for a worse one.

## `_resolve_org_id`'s path-parameter branch never ran

`RLSOrgContextMiddleware._resolve_org_id` began with
`if "org_id" in request.path_params`, documented as "the router has already
matched the URL by the time middleware sees it". Starlette's `Router` populates
`scope["path_params"]` while *matching*, downstream of every middleware.
Verified against a real app: inside middleware `"path_params" not in scope` and
`request.path_params == {}`, while the handler for the same request sees
`{"org_id": ...}`. The branch had never fired.

`QuotaEnforcementMiddleware` already records this at `quota_enforcement.py:271`
and resolves from header/cookie/API-key only; the note was never carried across.
Removed rather than repaired — the raw path is client-supplied exactly like
`X-Org-Id`, so it would need the same `_has_verified_identity` gate, and once
identity is verified the org from the token or the key-scoped header is better
evidence than a URL segment.

Five tests in `test_rls_streaming_and_org_resolution_jul27.py` were resolving
their org through that dead branch, by putting `path_params` in a hand-built
scope. They passed while exercising a path no request can take.

## `invalidate_caches()` did not reach the zstd batch pool

`eden.storage.compression` tracks a dict id on each of its two process-wide
caches, and the comment above them records this exact failure —
`ZstdError: Dictionary mismatch` — being diagnosed and fixed for them. The fix
was never applied one tier down: `_worker_compressor` / `_worker_decompressor`
returned any already-built thread-local object unconditionally, so after a
dictionary retrain the eight `zstd-batch` worker threads kept the old dictionary
for the process's life. That tier is the production write path
(`_route_postgres` → `compress_many`), so a retrain produced frames written
against two different dictionaries in one column, plus intermittent
`Dictionary mismatch` on reads depending on which worker thread picked the call
up. Fixed with a generation counter that all four accessors compare against —
which also closes a smaller hole, since `id(d)` alone can be recycled onto the
replacement dict after `get_dict.cache_clear()` frees the old one.

Found by accident: adding a test file that warmed the pool before
`test_compression_v18.py` swapped dictionaries made two of its tests fail.

## `alembic upgrade head` cannot succeed on a fresh database

Pre-existing, unrelated to any change in this remediation, and a deployment
blocker rather than a performance note.

Alembic creates `alembic_version.version_num` as `varchar(32)`. Two revision
ids exceed that:

    35 chars: 118_improvement_plans_closed_status
    37 chars: 124_missing_columns_both_sides_assume

An existing database is fine — its `alembic_version` row was written when the
column was wide enough, or the ids predate the length. A **fresh** database
dies at 118 with `StringDataRightTruncation`, which means CI's "Apply
migrations" step fails on any fresh volume, and so would a new environment.

Verified two ways: by measuring the id lengths directly, and by an agent that
reproduced the failure in a throwaway `timescale/timescaledb-ha:pg16` container
and confirmed it passes when `alembic_version` is pre-created as
`varchar(255)`.

Two fixes, and the choice matters:

* Widen the column (`version_table_pk` / an explicit `ALTER` in `env.py`, or a
  pre-create hook). Non-destructive, works for existing and fresh databases.
* Shorten the two ids. Clean, but rewrites history: every `down_revision`
  referencing them, the `docs/ops/migration-matrix.md` rows, and the
  `alembic_version` value in any database already at one of those revisions.

Widening is the safer of the two and the one to reach for unless someone wants
the ids tidied deliberately.

### Resolved — and it was three bugs, not one

Fixed in `src/eden/db_migrations/version_table.py`, wired into `env.py`, and
proven end to end against a throwaway `timescale/timescaledb-ha:pg16`
container. A fresh database now reaches head: **281 tables, `version_num`
`varchar(128)`, head `125_clickhouse_fallback_drain`**, with `downgrade -1` /
`upgrade head` clean afterwards.

Attempting the fix surfaced two further defects that stood *in front of* the
truncation, both invisible to the test suite because pytest never invokes the
alembic CLI:

**1. `env.py` imported the wrong `eden` package.** It put the *project root* on
`sys.path`, and the project root contains no `eden` package — so the name fell
through to the editable install, whose `.pth` lists `sdk/python` before `src`.
`sdk/python/eden` is the **SDK**. Every `alembic upgrade head` outside pytest
died at import with `ModuleNotFoundError: No module named 'eden.config'`,
before a single revision ran. `pyproject.toml` already documents this exact
shadow for pytest (`pythonpath = ["src", "."]`); the CLI never got the same
fix. This means the truncation at 118 had never actually been reachable from
the CLI — the import killed it first.

**2. My own first fix silently rolled back every migration.** Widening an
*existing* narrow column needs a query before alembic starts. Under
SQLAlchemy 2.0 that query implicitly opens a transaction; alembic's
`begin_transaction()` then treats it as externally managed, declines to commit
it, and `with connectable.connect()` rolls back on close. Measured: `alembic
upgrade head` logged all 125 revisions, **exited 0, and left 0 tables**. With
`connection.commit()` after the widening: 281 tables. Identical exit status
and identical log output either way — the same "cannot work, cannot fail
loudly" class this document keeps recording, this time authored by the
remediation rather than found by it. Caught only because the resulting state
was checked instead of the exit code.

Two mechanisms, because there are two populations of database:

* `use_wide_version_table()` overrides alembic's documented
  `version_table_impl` hook so the column is created at 128 — fixes **fresh**
  databases.
* `ensure_version_table(connection)` `ALTER`s an existing narrow column —
  fixes databases created before this. Verified by upgrading to 117,
  narrowing the column back to `varchar(32)`, and confirming the next
  `upgrade head` widens it and completes.

Guards: `tests/migrations/test_alembic_version_table_width.py`, 6 tests that
need no database plus 2 `realdb` ones. All four regressions were
mutation-verified — reverting the `sys.path` line, dropping the
`use_wide_version_table()` call, dropping the `connection.commit()`, and
resetting the width to alembic's stock 32 each fail the intended test.

Incidental finding: **`alembic upgrade --sql` (offline mode) does not work in
this project at all**, and cannot be made to. The revisions guard themselves
with `_table_exists()`, which calls `op.get_bind().execute(...)`; with no
connection that returns `None` and the run dies on `AttributeError:
'NoneType' object has no attribute 'first'`. Worth knowing before anyone plans
a review-the-SQL-then-apply deployment. `docs/MIGRATION.md` should not promise
it.

A fresh database also requires both the `timescaledb` and `vector` extensions
to be available on the server; neither `CREATE EXTENSION IF NOT EXISTS` can
install them. `postgres:16-alpine` fails on `vector`, `pgvector/pgvector:pg16`
then fails on `timescaledb`; `timescale/timescaledb-ha:pg16` has both.

## Four blake2b implementations of one idea

`eden.util.stable_hash` was introduced to replace the process-salted builtin
`hash()` wherever a value was persisted, bucketed or seeded. It landed
alongside three existing hand-rolled blake2b implementations doing the same
thing:

| site | construction |
|---|---|
| `predictive/_common.py::_hash_bucket` | `blake2b(text, 8) % n_buckets` |
| `predictive/risk.py::_hash_bucket_inline` | the same, with `% 64` hard-coded |
| `observability/sampling/policy.py::trace_keep_position` | `blake2b(salt + trace_id, 8) / 2**64` |

`_hash_bucket_inline`'s own docstring justified the copy: it did not want to
"gate on the helper's lazy import". That rationale expired the moment
`_hash_bucket` stopped importing `hashlib` inside the function body.

All three now delegate to `stable_hash` / `stable_bucket`. **Values are
unchanged**, which was the whole risk: bucket assignments feed PSI comparisons
across time windows and decide which traces sampling keeps, so a shifted
mapping would read as topic drift that never happened, or as a sampled corpus
that silently changes identity. The golden vectors in
`tests/unit/util/test_blake2b_reconciliation.py` were captured by running the
*old* implementations before touching them, and are asserted against the new
ones — identical for every non-empty input across ASCII, non-ASCII, a
500-character body, and every `rng_seed` case.

Two things the reconciliation turned up:

* **The empty-string guard is load-bearing, not decorative.** `_hash_bucket("")`
  returns `0`; `stable_bucket("", 64)` returns `52`. The drift path passes raw
  prompt/response bodies and missing ones arrive as `""`, so without the guard
  every trace with no captured body would pile into bucket 52 and be
  indistinguishable from a real topic cluster there. Pinned from both sides so
  the guard cannot be deleted as redundant.
* **`risk.py` and `drift.py` were one constant change away from silent
  disagreement.** `risk.py` passed a literal `n_buckets=64` to `_psi` while
  leaving the bucketing on `_hash_bucket`'s `EMBEDDING_BUCKETS` default — two
  independent spellings of the same number. Both modules label their PSI
  "embedding drift", so raising `EMBEDDING_BUCKETS` would have made the two
  numbers incomparable with nothing to signal it. Both now pass
  `EMBEDDING_BUCKETS` explicitly. (The default alone is not equivalent: it
  binds at `def` time in `_common`, so it would not follow a changed constant
  while the `_psi` argument would.)

Guard: `hashlib.blake2b(` may now appear at exactly one path in `src/eden`,
`util/stable_hash.py`. Mutation-verified by adding a fourth implementation to
`risk.py` and confirming the test fails.

`evaluation/eval_intel/failure_clusters.py::_stable_hash` was deliberately left
alone: it is SHA-256 producing a persisted `clu_…` **id**, not a bucket, and
changing it would rename every existing cluster.

## A CSS class that was never defined

`eden-skeleton-pulse` was applied in **25 places across four files** — both
route-level `loading.tsx` shells, the auth loading shell and the invite panel —
and had **zero** definitions anywhere in the tree. Every one of those skeletons
rendered as a flat, motionless block: the thing that says "this page is broken"
rather than "this page is loading".

Nothing reported it, and nothing could have. An undefined class name is not an
error in CSS, not in Tailwind, and not in TypeScript, which sees `className` as
a plain string. The only signal was visual, on loading states that are by
definition transient.

Defined once in `styles/components.css`, which animates all 25 usages.
`opacity` rather than a gradient `background`, because every call site already
sets its own background utility (`--line`, `--bg-inset`, `--accent-muted`) and a
shimmer would have to override them, flattening three placeholder tones into
one. No `prefers-reduced-motion` block is needed: `globals.css` already clamps
every animation to a single 0.01 ms iteration under that query, which settles
this one fully opaque.

The guard is `clients/portal/src/styles/custom-classes.test.ts`, and it targets
the class of bug rather than the instance: every `eden-*` token appearing in a
`className` must have a CSS rule. Scope matters — a first pass grepping for
`eden-` anywhere reported 25 violations, nearly all legitimate non-CSS
identifiers (the `eden-plausible-script` DOM id, `eden-export-` API prefixes,
`eden-portal-shell` tour anchors). Narrowed to `className` attributes it finds
exactly one true positive and no noise, which is the difference between a gate
people keep and a gate people mute.

## Two semgrep rule files that could never load

Found by running `pre-commit run --all-files` and reading *all* of the
`check-yaml` output rather than the first failure. Nine files failed. Six were
Helm templates — Go templates with a `.yaml` suffix, which no YAML parser can
accept — and one was `northflank.yml`, a legitimate three-document file the
hook was reading single-document. The other two were real:

* `.semgrep/rules/auth-bypass.yml` wrote `pattern: user: dict =
  get_current_user` unquoted. The value contains `": "`, which YAML reads as a
  nested mapping key, so the document was malformed from line 9 on.
* `.semgrep/strict/hardcoded-secrets.yml` wrote its regex as
  `'...["\'][^"\']+["\']'`. Inside a **single-quoted** YAML scalar a quote is
  escaped by doubling it, not with a backslash — so the scalar ended at the
  first `'` and the rest of the regex was parsed as YAML structure.

Both files loaded **zero rules**, including the hardcoded-JWT-secret and
hardcoded-API-key detectors. Same signature as everything else in this
document: nothing raised, and a scanner with unparseable rules is
indistinguishable from a scanner that found nothing.

Nothing currently invokes semgrep — it appears only in `CODEOWNERS` — so no
scan was actually skipped. The rules would have failed to load the moment
someone wired it up, which is the worst time to find out.

Fixed by quoting correctly; the regexes are unchanged in meaning (`\'` inside a
character class is just `'`), which is asserted by executing them rather than
by inspection. Guard: `tests/security/test_semgrep_rules_load.py` — every rule
file must parse, declare at least one rule, and have a `pattern-regex` that
compiles, with the secret detectors checked against both a positive and a
negative case. Mutation-verified by restoring one of the quoting bugs.

The `check-yaml` hook itself was also fixed (`--allow-multiple-documents`, and
an exclude for `helm/eden/templates/`). While it failed on six files it could
never pass, and a gate that can never pass is how these two broken rule files
sat behind it unnoticed.

### What `pre-commit run --all-files` still cannot do

It is not a read-only gate — the `ruff` hook runs with `--fix` and **rewrote 64
files** when I ran it. Worth knowing before running it against a large
uncommitted diff. (The changes were mechanical: unused imports, a blank line,
and `with a, b:` rewritten into the parenthesised form. Full suite re-run green
afterwards.)

Two hooks still fail, both on large pre-existing baselines rather than anything
from this remediation:

* **Ruff lint** — 317 errors under the project's own ruff 0.15.15 across
  `src/` and `tests/` (416 under the v0.6.9 the hook pins). Dominated by
  naming rules (104 × `N815`, 36 × `N802`) and 54 × `B008`, which is the
  standard FastAPI `Depends()`-in-defaults false positive. Burning these down
  means renaming symbols; that is a deliberate decision, not a cleanup.
* **MyPy** — 1689 errors across 455 files, substantially inflated because the
  hook runs in an isolated environment declaring only nine dependencies, so
  most third-party imports resolve to `Any` or fail outright.

CI already encodes this reality by running ruff and mypy with `|| true`. The
plan's "`pre-commit run --all-files` must stay green" gate has therefore never
been achievable; it is recorded here so the next person does not read the red
output as damage from this work.
