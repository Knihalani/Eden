"""Quarantine reprocessing must not delete what it never reprocessed.

``reprocess_quarantine`` read the quarantined payloads, skipped any that
failed ``json.loads`` with a bare ``continue``, ran the rest, and then —
if *any* event inserted — deleted **every** id in the request.

So a batch of 10 where 3 payloads were corrupt and 7 inserted deleted
all 10. The quarantine table is the only copy of those events, which
made this permanent, silent data loss in the one place specifically
built to avoid losing data. A partial insert had the same shape.

Also covers the companion false-success log: ``_push_clickhouse``
returned early when no sink was configured while ``run_batch`` logged
"Pushed N events to ClickHouse" regardless.
"""

from __future__ import annotations

import json

import pytest

from eden.data_platform.silver_etl import SilverETLPipeline


class FakeClient:
    """Records the DELETE so the test can assert on exactly what went."""

    def __init__(self, rows):
        self._rows = rows
        self.deleted_ids: list[str] = []
        self.deletes_issued = 0

    async def fetch(self, _query, *args):
        return self._rows

    async def execute(self, query, *args):
        if "DELETE FROM quarantine_events" in query:
            self.deletes_issued += 1
            self.deleted_ids.extend(str(a) for a in args)
        return "DELETE 0"


def _row(qid: str, payload) -> dict:
    return {
        "quarantine_id": qid,
        "raw_payload": payload if isinstance(payload, str) else json.dumps(payload),
    }


class _Report:
    def __init__(self, inserted: int):
        self.silver_inserted = inserted


@pytest.fixture
def pipeline(monkeypatch):
    return SilverETLPipeline()


async def _run(pipeline, monkeypatch, rows, inserted):
    client = FakeClient(rows)

    async def _pg():
        return client

    async def _run_batch(events, **kwargs):
        return _Report(inserted)

    monkeypatch.setattr(pipeline, "_get_postgres", _pg)
    monkeypatch.setattr(pipeline, "run_batch", _run_batch)
    ids = [r["quarantine_id"] for r in rows]
    report = await pipeline.reprocess_quarantine(ids)
    return client, report


class TestReprocessQuarantineDeletion:
    @pytest.mark.asyncio
    async def test_unparseable_rows_are_never_deleted(self, pipeline, monkeypatch):
        rows = [
            _row("q1", {"event_type": "a"}),
            _row("q2", "{not valid json"),
            _row("q3", {"event_type": "c"}),
        ]
        # Both parseable events inserted -> full success for those two.
        client, _ = await _run(pipeline, monkeypatch, rows, inserted=2)

        assert "q2" not in client.deleted_ids, (
            "a row whose payload could not be parsed was never "
            "reprocessed; deleting it destroys the only copy"
        )
        assert sorted(client.deleted_ids) == ["q1", "q3"]

    @pytest.mark.asyncio
    async def test_partial_insert_deletes_nothing(self, pipeline, monkeypatch):
        rows = [
            _row("q1", {"event_type": "a"}),
            _row("q2", {"event_type": "b"}),
            _row("q3", {"event_type": "c"}),
        ]
        # Only 1 of 3 landed.
        client, _ = await _run(pipeline, monkeypatch, rows, inserted=1)

        assert client.deletes_issued == 0, (
            "a partial insert must not clear the quarantine; the rows "
            "whose data did not land would be lost"
        )

    @pytest.mark.asyncio
    async def test_full_success_clears_the_reprocessed_rows(
        self, pipeline, monkeypatch
    ):
        rows = [
            _row("q1", {"event_type": "a"}),
            _row("q2", {"event_type": "b"}),
        ]
        client, _ = await _run(pipeline, monkeypatch, rows, inserted=2)
        assert sorted(client.deleted_ids) == ["q1", "q2"]

    @pytest.mark.asyncio
    async def test_all_unparseable_deletes_nothing(self, pipeline, monkeypatch):
        rows = [_row("q1", "{bad"), _row("q2", "also bad")]
        client, _ = await _run(pipeline, monkeypatch, rows, inserted=0)
        assert client.deletes_issued == 0
        assert client.deleted_ids == []


class TestClickhousePushHonesty:
    @pytest.mark.asyncio
    async def test_missing_sink_reports_not_pushed(self, pipeline, monkeypatch):
        """A no-op push must be distinguishable from a real one."""
        import eden.data_platform.silver_etl as mod

        async def _no_sink():
            return None

        monkeypatch.setattr(mod, "get_clickhouse_sink", _no_sink)
        pushed = await pipeline._push_clickhouse([{"silver_event_id": "s1"}])
        assert pushed is False, (
            "run_batch logs 'Pushed N events to ClickHouse' off this "
            "return value; a missing sink must not report success"
        )
