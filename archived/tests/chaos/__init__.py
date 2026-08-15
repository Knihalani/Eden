"""Chaos test suite (closes §9.4 / Phase 4 C2).

The suite covers 5 failure modes:

1. ``test_postgres_kill.py`` — postgres connection drops mid-insert.
   The ingest loop must retry until reconnect succeeds.
2. ``test_clickhouse_timeout.py`` — ClickHouse query times out.
   The columnar engine falls back to Postgres gracefully.
3. ``test_webhook_503_cascade.py`` — webhook receiver returns 503
   100× in a row. The DLQ catches + replay works.
4. ``test_openai_circuit_breaker.py`` — OpenAI returns 429.
   The circuit breaker trips + recovers.
5. ``test_llm_rate_limit_storm.py`` — 10k req/min burst.
   Backpressure keeps queue depth under 1000.

These tests use mocks for the failure injection (no live DB kill
in CI). They run nightly via ``.github/workflows/chaos-nightly.yml``
to catch regressions in the resilience paths.

Per the design, each test asserts the system SURVIVES the
failure mode — not that it succeeds with zero impact. Some
degradation is acceptable (e.g. latency spikes, partial drops);
what's NOT acceptable is data loss or a system-wide 5xx cascade.
"""
