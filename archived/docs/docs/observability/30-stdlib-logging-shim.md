---
title: "30 — Stdlib logging shim (Phase R)"
status: IMPLEMENTED v1
last_updated: 2026-06-17
version: 1.0
---

# 30 — Stdlib logging shim (Phase R)

> **Status:** ✅ **IMPLEMENTED v1** (shipped 2026-06-17).
> This is the Logfire-style 5-minute time-to-first-log surface.
> One import → every `logging.info("...")` in the user's app
> (and the 50+ third-party libraries that use stdlib logging)
> becomes a searchable, queryable, dashboardable event in Eden.
> No code changes required. ~470 LOC backend + 36 unit tests.

## Goal & motivation

The user-feedback that started this phase: **"I want to instrument
my existing app in 30 seconds, not write decorators."**

Pydantic Logfire's killer feature isn't the AI judges or the
trace view — it's `import logfire; logfire.install()` and now
your existing `logging.info("...")` calls are visible. Eden had
the same backend infrastructure (9 ingest-format decoders,
Typesense full-text search, the `telemetry_events` table) but
no zero-config path to feed it.

Phase R closes that gap with the smallest possible surface
area: **one new module** (`logging_shim.py`), **zero new
database tables**, **one new event_type** (`"log"`), and
**zero changes to the existing API surface** — log events flow
through the same `TelemetryEventIngest` route as everything else.

## What's in Eden

### The one-liner

```python
import eden
eden.install()           # or eden.install_logging()
```

After this, every existing `logging.info("...")` call — in the
user's code, in `requests`, in `urllib3`, in `sqlalchemy`, in
**anything that uses stdlib logging** — becomes a
`TelemetryEvent(event_type="log")` in the pipeline. No code
changes required.

The same call sets `EDEN_LOG_LEVEL=INFO` by default; the user
can override with an env var, a setting, or an explicit kwarg:

```python
eden.install(level=logging.WARNING)              # explicit
# or
EDEN_LOG_LEVEL=WARNING python myapp.py           # env var
# or
Settings(eden_log_level="WARNING")               # config
```

### Architecture

```
User code:  logging.info("step %s", step)
                        │
                        ▼ (stdlib logging framework)
                Root logger + EdenLoggingHandler
                        │
                        │  emit() converts LogRecord →
                        │  TelemetryEvent dict
                        │
                        │  honours set_trace_context() —
                        │  the active trace_id is bound via
                        │  contextvars
                        │
                        ▼
        TelemetryCollector.ingest(event)
                        │
                        ├─→ Redis (hot path)
                        ├─→ Postgres (cold path)
                        ├─→ ClickHouse (analytics)
                        ├─→ Typesense (full-text search)
                        └─→ WebSocket fanout
```

### What gets captured per log record

| Field | Source | Example |
|---|---|---|
| `event_type` | always `"log"` | `log` |
| `event_id` | content-hash of `(trace, level, seq)` | `log-abc-20-7f3a9c` |
| `trace_id` | `_active_trace_id` contextvar or synthetic `ambient-<project>-<pid>-<seq>` | `trace-xyz` or `ambient-myapp-1234-1` |
| `span_id` | `_active_span_id` contextvar (or the function name for ambient records) | `span-1` |
| `project_id` | `_active_project_id` contextvar or handler default | `myapp` |
| `tenant_id` | `_active_tenant_id` contextvar or handler default | `org-42` |
| `name` | `record.name` (logger name) | `myapp.module` |
| `payload.message` | `record.getMessage()` (handles `%s` interpolation) | `step 3` |
| `payload.exc_text` | formatted `traceback.format_exception(*record.exc_info)` | `Traceback (most recent call last):\n  …\nValueError: boom` |
| `payload.extras` | user-attached `record.user_id = "u-1"` etc. | `{"user_id": "u-1"}` |
| `attributes.logger` | `record.name` | `myapp.module` |
| `attributes.level` | `record.levelname` | `INFO` |
| `attributes.module` | `record.module` | `module` |
| `attributes.line` | `record.lineno` | `42` |
| `attributes.func` | `record.funcName` | `do_step` |
| `attributes.thread` | `record.threadName` | `MainThread` |
| `attributes.process` | `record.processName` | `MainProcess` |
| `tags` | `["level:INFO"]` (etc per level) | `["level:INFO"]` |
| `outcome` | `failure` (ERROR/CRITICAL) / `partial` (WARNING) / `None` (INFO/DEBUG) | `failure` |
| `source_format` | always `"logging_shim"` | `logging_shim` |

### Threading model

The handler is **non-blocking** in every case:

1. `emit()` is called by the logging framework, possibly from a
   worker thread.
2. `emit()` builds the event (cheap, no I/O) and pushes onto a
   bounded queue (max 1024 events, drops oldest on overflow).
3. `emit()` tries to find a running event loop:
   - **In a worker thread with the app's main loop running**: uses
     `loop.call_soon_threadsafe()` to schedule a drain on the
     main loop.
   - **In the main loop's thread**: same path as above (the
     drain coroutine is scheduled on the current loop).
   - **In a sync CLI / no running loop**: runs an ad-hoc
     `asyncio.run()` synchronously to drain the queue. The user
     code never blocks on us.

If the user code produces logs faster than the collector can
ingest, the handler drops the oldest with a counter, never the
newest. Diagnostics: `handler.stats()` returns
`{ingested, dropped, failed, no_loop, queued}`.

### Setting the trace context

The shim is a no-op until you give it a trace. Inside an active
trace (e.g. inside a `with trace("..."):` block from the SDK),
`set_trace_context()` is called automatically. In a script that
wants to attribute logs to a specific trace manually:

```python
from eden.observability import set_trace_context, clear_trace_context
import logging

set_trace_context(trace_id="abc", span_id="def", project_id="p1", tenant_id="org-42")
logging.info("step 1")   # attributed to trace abc, span def
logging.info("step 2")   # attributed to trace abc, span def
clear_trace_context()
logging.info("step 3")   # falls back to ambient trace
```

`set_trace_context` uses a private sentinel so the semantics are
clear:

- Omit a kwarg → field unchanged
- Pass `None` → field cleared
- Pass a string → field set

`clear_trace_context()` clears all four fields in one call.

### Console-local view (next step)

Phase R ships the **backend**; the **console view** in the portal
is wired through the existing trace view. Because log events
have `event_type="log"`, the timeline component already renders
them inline alongside spans. A dedicated "Console" tab in the
trace detail page is a UI-only follow-up that does not require
backend changes — it's a Phase E (UI polish) candidate.

## API surface

| Symbol | Where | What it does |
|---|---|---|
| `EdenLoggingHandler` | `eden.observability.logging_shim` | The handler class. Attach via `getLogger().addHandler(...)` for fine control. |
| `install()` / `install_logging()` | `eden.observability` | One-liner: attaches handler to root logger. Idempotent. |
| `uninstall()` / `uninstall_logging()` | `eden.observability` | Removes the handler. |
| `is_installed()` / `is_logging_shim_installed()` | `eden.observability` | Boolean: is the shim attached? |
| `get_handler()` / `get_logging_handler()` | `eden.observability` | Returns the attached handler (or `None`). |
| `set_trace_context(...)` | `eden.observability` | Bind the current async / thread context to a trace. |
| `clear_trace_context()` | `eden.observability` | Clear all bindings. |

## Settings

| Setting | Env var | Default | What it does |
|---|---|---|---|
| `eden_log_level` | `EDEN_LOG_LEVEL` | `"INFO"` | Minimum level captured. |
| `eden_log_project` | — | `"default"` | Project id for orphan log records. |
| `eden_log_tenant` | — | `"default"` | Tenant (org slug) for log events. |
| `eden_log_agent_id` | — | `""` | Optional agent id for cross-referencing. |
| `eden_log_realm` | — | `"production"` | `"production"` or `"environment"`. |

## What this does NOT do (deferred)

- **Auto-instrument 3rd-party loggers** — we attach to the root,
  so this works automatically. No opt-in list needed.
- **Custom formatter** — the handler reads structured fields
  (extras, exc_info) but does not run the user's `Formatter`.
  Console output is unchanged.
- **Rich Python object display** (Logfire parity) — the user
  can pass objects via `extra=` and the handler JSON-serialises
  them (with a `repr()` fallback for non-serialisable values).
  Full rich-display is a Phase E (UI polish) item.
- **AST auto-trace** (Logfire parity) — not in scope. We have
  the decorator + gateway story; AST rewriting adds complexity
  with little UX win.

## Failure modes & telemetry

| Failure | Behaviour |
|---|---|
| Postgres sink down | Event logged, `failed` counter bumps, drops. User app never blocks. |
| ClickHouse sink down | Same as Postgres — silent skip, `dropped` bumps. |
| Typesense sink down | Same as Postgres. |
| Collector itself unreachable | Event stored on bounded queue; if queue overflows, oldest dropped. |
| Record with unformattable message | `getMessage()` failure is caught, fallback to `str(record.msg)`. |
| Invalid `extra={...}` value (non-JSON-serialisable) | Falls back to `repr(value)`. The event is still ingested. |
| `emit()` raises for any reason | Counter bumps; **never** re-raises (would break the user's logger chain). |

The handler is observable through the existing Telemetry
health-check + a new health route (`/orgs/{org}/logging-shim/health`)
that returns `handler.stats()` for ops dashboards.

## Tests

36 unit tests in `tests/unit/observability/test_logging_shim.py`:

- `TestEmitBasicShape` (4) — event_type, trace_id, span_id,
  ambient trace fallback, project fallback.
- `TestEmitLevelMapping` (5) — DEBUG/INFO → `outcome=None`,
  WARNING → `"partial"`, ERROR/CRITICAL → `"failure"`.
- `TestEmitExceptionCapture` (2) — `exc_info` formatted
  correctly, no exc → empty string.
- `TestEmitExtras` (3) — `record.user_id = "u-1"` captured,
  non-serialisable falls back to repr, reserved stdlib fields
  not leaked.
- `TestQueueOverflow` (1) — bounded at 1024, drops oldest.
- `TestInstall` (7) — attaches, idempotent, replace flow,
  uninstall, env-var level, kwargs, defaults.
- `TestGetters` (2) — `get_handler()` returns the instance.
- `TestEndToEndEmit` (3) — full ingest to a mocked
  `TelemetryCollector`, worker-thread safety, unformattable
  message survival.
- `TestContextVarIsolation` (2) — set / clear / partial clear.
- `TestParseLevel` (7) — string→int, int passthrough,
  unknown → INFO.

All 36 pass; 0 regressions in the existing 318-test
`tests/unit/observability/` suite.

## Why not just use a third-party shim?

We could have shipped `loguru`-to-Eden or `structlog`-to-Eden
adapters, but every Python app uses stdlib logging, and most
adopt one of these only AFTER they already need log
aggregation. Shipping the stdlib path first means **a user with
zero new dependencies** can get Eden working in 30 seconds. The
third-party shims (loguru, structlog) are good follow-ups and
trivial to add — they all expose a handler-shaped adapter.

## Competitive positioning

| Competitor | What they ship | Eden's Phase R |
|---|---|---|
| **Pydantic Logfire** | `logfire.install()`, `logfire.info()`, AST auto-trace, Pydantic validation analytics, rich display, stdlib shim | Stdlib shim (parity on the install UX). Defer: AST auto-trace (decorator + gateway already cover the high-value cases), rich display (Phase E). |
| **lmnr-ai/lmnr** | No stdlib shim — only SDK-based instrumentation | We beat them on the 5-minute UX. |
| **raga-ai-hub/RagaAI-Catalyst** | No stdlib shim | We beat them. |

## Cross-references

- [Cat 22 APM depth](22-apm-tracing-depth.md) — the
  pipeline the shim feeds into.
- [Phase A — content-addressed dedup](22-apm-tracing-depth.md#10-message-level-dedup-laminar-20x-parity-v141)
  — same content-hash pattern is used for event_id generation.
- [Phase B — full-text search](19-trace-query-dsl.md) —
  log events are indexed by Typesense; `q=ValueError` finds
  the record and surrounding log lines.
- [Phase C — unified AI agent](14-autonomous-intelligence.md)
  — the agent can now search log events with the
  `search_spans` tool (which queries both spans AND log events
  through Typesense).
