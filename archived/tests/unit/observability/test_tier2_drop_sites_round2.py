"""Wave 4, second pass: losses that were invisible or actively misreported.

The first pass covered buffers that dropped rows on an early return. These
are subtler — each one *reports* something, and what it reports is wrong.

* ``quality_pipeline.dead_letter`` is the pipeline's last resort, and it
  swallowed its own failure and returned ``None``. Two consequences: the
  caller's ``except Exception: logger.error("dead-letter failed…")`` was
  unreachable dead code, and both callers then incremented
  ``traces_total{status="dlq"}`` unconditionally — reporting a trace as
  safely dead-lettered when no row existed. The watermark advances
  regardless, so such a trace is recoverable only by rewinding it by hand.
* ``persist_reports`` logged a per-step write failure at DEBUG. Because
  ``_process_one`` only dead-letters when *every* step is ``None``, a
  4-of-5 partial failure counted as ``status="ok"``.
* ``TypesenseClient.index_many`` bypasses ``_request``, so it also bypassed
  the drop accounting ``_request`` grew. Worse, its import endpoint answers
  **200** with one result line per doc, so a partial failure is a short
  count rather than an error — and nothing compared that count to the batch
  size. It also set ``_last_failure`` directly instead of calling
  ``_record_failure()``, so no number of bulk failures could trip the
  breaker.
* ``LiveTracePublisher.finalize`` publishes the ``trace_finalized`` event
  that tells the UI a trace is done. ``force=True`` bypassed the
  feature-flag and no-subscriber checks but *not* the rate limiter, and the
  result was embedded in the response and otherwise ignored — so a session
  that had just tripped its own rate limit got a ``status: "ok"`` finalize
  and a UI stuck on "in progress".
* The ingest decoders skip unparseable sub-items, and the route builds its
  response from the *post-skip* list, so 40 malformed spans out of 100 were
  reported as "60 accepted of 60". ``providers.py`` also lacked the
  all-skipped backstop its siblings have.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import pytest

from eden.observability.drop_metrics import get_drop_metrics, reset_for_tests


@pytest.fixture(autouse=True)
def _clean() -> None:
    reset_for_tests()
    yield
    reset_for_tests()


def _drops(stage: str, reason: str) -> float:
    return get_drop_metrics().get((stage, reason), 0.0)


class _FakePG:
    """Minimal Postgres double. ``fail_on`` substring-matches the SQL."""

    def __init__(self, fail_on: str | None = None) -> None:
        self.fail_on = fail_on
        self.executed: list[str] = []

    async def execute(self, sql: str, *args: Any) -> None:
        self.executed.append(sql)
        if self.fail_on and self.fail_on in sql:
            raise RuntimeError(f"write refused: {self.fail_on}")

    async def fetchrow(self, sql: str, *args: Any) -> dict[str, Any]:
        # ``_upsert_report`` goes through fetchrow (it needs RETURNING id),
        # while ``dead_letter`` uses execute. A fake missing this method made
        # every step fail with AttributeError, which looks exactly like the
        # partial-failure case under test — so support both explicitly.
        self.executed.append(sql)
        if self.fail_on and self.fail_on in sql:
            raise RuntimeError(f"write refused: {self.fail_on}")
        return {"id": "00000000-0000-0000-0000-000000000001"}

    def transaction(self) -> Any:
        class _Tx:
            async def __aenter__(self) -> None:
                return None

            async def __aexit__(self, *a: object) -> bool:
                return False

        return _Tx()


class TestDeadLetterFailureIsLoud:
    @pytest.mark.asyncio
    async def test_it_reports_false_and_counts_the_loss(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        from eden.observability.quality_pipeline import worker as w

        pg = _FakePG(fail_on="quality_pipeline_failed_traces")
        monkeypatch.setattr(
            "eden.storage.postgres.get_postgres_client",
            lambda: _async(pg),
        )
        with caplog.at_level(logging.ERROR):
            landed = await w.dead_letter("t1", "tr1", "boom", [{"a": 1}])

        assert landed is False, "a failed dead-letter write must not report success"
        assert _drops("sink_pg", "write_error") == 1.0
        assert any(
            "dead-letter write FAILED" in r.message for r in caplog.records
        ), "the last-resort failure must be logged at ERROR"

    @pytest.mark.asyncio
    async def test_a_successful_write_reports_true(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from eden.observability.quality_pipeline import worker as w

        pg = _FakePG()
        monkeypatch.setattr(
            "eden.storage.postgres.get_postgres_client", lambda: _async(pg)
        )
        assert await w.dead_letter("t1", "tr1", "boom", [{"a": 1}]) is True
        assert _drops("sink_pg", "write_error") == 0.0

    @pytest.mark.asyncio
    async def test_an_absent_client_is_reported_not_swallowed(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        from eden.observability.quality_pipeline import worker as w

        monkeypatch.setattr(
            "eden.storage.postgres.get_postgres_client", lambda: _async(None)
        )
        with caplog.at_level(logging.ERROR):
            assert await w.dead_letter("t1", "tr1", "boom", []) is False
        assert _drops("sink_pg", "write_error") == 1.0
        assert caplog.records, "an absent client must still be announced"


class TestPartialPersistIsCounted:
    @pytest.mark.asyncio
    async def test_one_failed_step_is_counted_and_logged(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The dangerous case: the trace is still reported ``status="ok"``."""
        from eden.observability.quality_pipeline import worker as w

        # Fail exactly one of the four report tables.
        target = w._TABLES["loop"]
        pg = _FakePG(fail_on=target)
        monkeypatch.setattr(
            "eden.storage.postgres.get_postgres_client", lambda: _async(pg)
        )
        reports = {
            step: {"status": "ok", "score": 1.0} for step in w._TABLES
        }
        with caplog.at_level(logging.WARNING):
            out = await w.persist_reports("t1", "tr1", reports)

        assert out["loop"] is None
        # The other three must have succeeded, or this is testing a total
        # failure (which already dead-letters) rather than a partial one.
        assert [k for k, v in out.items() if v is None] == ["loop"]
        assert _drops("sink_pg", "write_error") == 1.0
        assert any("cannot be retried" in r.message for r in caplog.records)

    @pytest.mark.asyncio
    async def test_an_absent_substrate_is_logged(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        from eden.observability.quality_pipeline import worker as w

        monkeypatch.setattr(
            "eden.storage.postgres.get_postgres_client", lambda: _async(None)
        )
        with caplog.at_level(logging.WARNING):
            out = await w.persist_reports("t1", "tr1", {"tas": {"status": "ok"}})
        assert all(v is None for v in out.values())
        assert any("cannot persist reports" in r.message for r in caplog.records)


class TestSamplingSummaryEvictionIsCounted:
    def test_the_oldest_summary_leaving_the_buffer_is_visible(self) -> None:
        from eden.observability.sampling.summaries import (
            SamplingSummaryStore,
            TraceSamplingSummary,
        )

        store = SamplingSummaryStore(max_buffered=3)
        for i in range(5):
            store.record(TraceSamplingSummary(org_id="o", trace_id=f"tr{i}"))

        assert len(store.buffered()) == 3
        assert _drops("sample", "queue_full") == 2.0

    def test_nothing_is_counted_below_the_cap(self) -> None:
        from eden.observability.sampling.summaries import (
            SamplingSummaryStore,
            TraceSamplingSummary,
        )

        store = SamplingSummaryStore(max_buffered=10)
        for i in range(5):
            store.record(TraceSamplingSummary(org_id="o", trace_id=f"tr{i}"))
        assert _drops("sample", "queue_full") == 0.0


class _FakeResp:
    def __init__(self, text: str) -> None:
        self._text = text
        self.status = 200

    async def text(self) -> str:
        return self._text

    async def __aenter__(self) -> _FakeResp:
        return self

    async def __aexit__(self, *a: object) -> bool:
        return False


class _FakeSession:
    def __init__(self, text: str) -> None:
        self.text = text

    def post(self, *a: object, **k: object) -> _FakeResp:
        return _FakeResp(self.text)


def _ts_client() -> Any:
    from eden.observability.typesense_client import TypesenseClient

    c = TypesenseClient(host="h", port=1, api_key="k")
    c._schema_ready = True
    return c


class TestTypesensePartialSuccessIsVisible:
    @pytest.mark.asyncio
    async def test_a_short_ok_count_is_counted_as_a_drop(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The import endpoint answers 200 with a per-line result."""
        client = _ts_client()
        body = "OK\n" + json.dumps({"success": False, "error": "bad field"})
        monkeypatch.setattr(client, "_get_session", lambda: _async(_FakeSession(body)))

        with caplog.at_level(logging.WARNING):
            ok = await client.index_many([{"id": "a"}, {"id": "b"}])

        assert ok == 1
        assert _drops("sink_search", "write_error") == 1.0, (
            "the rejected doc was not counted, so a run where every doc "
            "failed validation looked identical to a clean one"
        )
        assert any("rejected" in r.message for r in caplog.records)

    @pytest.mark.asyncio
    async def test_a_fully_successful_import_counts_nothing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        client = _ts_client()
        monkeypatch.setattr(
            client, "_get_session", lambda: _async(_FakeSession("OK\nOK"))
        )
        assert await client.index_many([{"id": "a"}, {"id": "b"}]) == 2
        assert _drops("sink_search", "write_error") == 0.0

    @pytest.mark.asyncio
    async def test_an_absent_session_counts_the_whole_batch(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        client = _ts_client()
        monkeypatch.setattr(client, "_get_session", lambda: _async(None))
        assert await client.index_many([{"id": "a"}, {"id": "b"}]) == 0
        assert _drops("sink_search", "write_error") == 2.0

    @pytest.mark.asyncio
    async def test_a_network_failure_advances_the_breaker(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """It used to set ``_last_failure`` without touching ``_failure_count``."""
        client = _ts_client()

        class _Boom:
            def post(self, *a: object, **k: object) -> Any:
                raise RuntimeError("connection refused")

        monkeypatch.setattr(client, "_get_session", lambda: _async(_Boom()))
        before = client._failure_count
        assert await client.index_many([{"id": "a"}]) == 0
        assert client._failure_count == before + 1, (
            "no number of bulk-import failures could ever open the breaker"
        )
        assert _drops("sink_search", "write_error") == 1.0


class _FakePipe:
    def hset(self, *a: object, **k: object) -> None:
        return None

    def expire(self, *a: object, **k: object) -> None:
        return None

    def rpush(self, *a: object, **k: object) -> None:
        return None

    def publish(self, *a: object, **k: object) -> None:
        return None

    def zadd(self, *a: object, **k: object) -> None:
        return None

    def zremrangebyrank(self, *a: object, **k: object) -> None:
        return None

    async def execute(self) -> list[Any]:
        return []


class _FakeRedis:
    """Enough of a Redis to let ``publish`` reach its gates and its write."""

    async def incr(self, *a: object) -> int:
        return 1

    async def get(self, *a: object) -> None:
        return None

    async def set(self, *a: object, **k: object) -> None:
        return None

    async def expire(self, *a: object, **k: object) -> None:
        return None

    async def rpush(self, *a: object, **k: object) -> int:
        return 1

    async def publish(self, *a: object, **k: object) -> int:
        return 1

    async def llen(self, *a: object) -> int:
        return 1

    async def ltrim(self, *a: object, **k: object) -> None:
        return None

    def pipeline(self, *a: object, **k: object) -> _FakePipe:
        return _FakePipe()


class TestFinalizeCloseEventSurvivesRateLimiting:
    @pytest.mark.asyncio
    async def test_force_bypasses_the_rate_limiter(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """``trace_finalized`` is the one event that must not be dropped."""
        from eden.observability.live import publisher as mod

        pub = mod.LiveTracePublisher()
        calls: list[str] = []

        def _gate(name: str):
            async def _inner(*a: object, **k: object) -> dict[str, Any]:
                calls.append(name)
                return {"status": "error", "code": name}

            return _inner

        monkeypatch.setattr(pub, "_enforce_rate", _gate("rate_limited"))
        monkeypatch.setattr(pub, "_enforce_session_cap", _gate("session_cap"))
        # A working Redis double is essential here: with ``_redis`` returning
        # None, ``publish`` takes the local-buffer path and returns *before*
        # the gates are consulted at all — so the assertion below would hold
        # no matter what the gate code did.
        monkeypatch.setattr(pub, "_redis", lambda: _async(_FakeRedis()))
        monkeypatch.setattr(pub, "_subscriber_count", lambda *a, **k: _async(1))
        monkeypatch.setattr(mod, "live_enabled", lambda: True)

        out = await pub.publish("o", "s", {"type": "trace_finalized"}, force=True)
        assert calls == [], f"force must skip the cap/rate gates, hit: {calls}"
        assert str(out.get("status")) != "error"
        assert out.get("code") not in ("rate_limited", "session_cap")

    @pytest.mark.asyncio
    async def test_a_rate_limited_ordinary_event_is_still_gated(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The gates must keep working for everything that is not a close."""
        from eden.observability.live import publisher as mod

        pub = mod.LiveTracePublisher()

        async def _rate(*a: object, **k: object) -> dict[str, Any]:
            return {"status": "error", "code": "rate_limited"}

        monkeypatch.setattr(pub, "_redis", lambda: _async(_FakeRedis()))
        monkeypatch.setattr(pub, "_subscriber_count", lambda *a, **k: _async(1))
        monkeypatch.setattr(pub, "_enforce_session_cap", lambda *a, **k: _async(None))
        monkeypatch.setattr(pub, "_enforce_rate", _rate)
        monkeypatch.setattr(mod, "live_enabled", lambda: True)

        out = await pub.publish("o", "s", {"type": "span_update"})
        assert out.get("code") == "rate_limited"


class TestDecodeSkipsAreCounted:
    @pytest.mark.asyncio
    async def test_an_unparseable_item_is_counted(self) -> None:
        from eden.observability.ingestion.attribution import Attribution
        from eden.observability.ingestion.providers import OpenAIDecoder

        attr = Attribution(tenant_id="t", project_id=None, source_format="openai")
        body = json.dumps([{"id": "chatcmpl-1", "model": "gpt-4o"}, 7, "nope"])
        events = await OpenAIDecoder().decode(body.encode(), attr)

        assert len(events) == 1
        assert _drops("ingest", "malformed") == 2.0, (
            "the route reports accepted=len(events), so uncounted skips are "
            "invisible to both the sender and the operator"
        )

    @pytest.mark.asyncio
    async def test_an_all_unparseable_body_is_rejected(self) -> None:
        """Previously returned 200 with accepted=0."""
        from eden.observability.ingestion.attribution import Attribution
        from eden.observability.ingestion.errors import SchemaInvalidError
        from eden.observability.ingestion.providers import OpenAIDecoder

        attr = Attribution(tenant_id="t", project_id=None, source_format="openai")
        with pytest.raises(SchemaInvalidError):
            await OpenAIDecoder().decode(b"[1, 2, 3]", attr)

    @pytest.mark.asyncio
    async def test_a_clean_body_counts_nothing(self) -> None:
        from eden.observability.ingestion.attribution import Attribution
        from eden.observability.ingestion.providers import OpenAIDecoder

        attr = Attribution(tenant_id="t", project_id=None, source_format="openai")
        body = json.dumps([{"id": "chatcmpl-1", "model": "gpt-4o"}])
        events = await OpenAIDecoder().decode(body.encode(), attr)
        assert len(events) == 1
        assert _drops("ingest", "malformed") == 0.0


def _async(value: Any) -> Any:
    """Return an awaitable resolving to ``value``."""

    async def _inner() -> Any:
        return value

    return _inner()
