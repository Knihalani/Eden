"""Regression cover for the quality pipeline's silent death + watermark.

The poll query used to ``SELECT id ... WHERE id::text = $1`` against
``telemetry_events``, whose key is ``event_id`` — there has never been an
``id`` column on that table. Every poll therefore raised
``UndefinedColumn``, the handler swallowed it and returned ``[]``, and the
loop read that as "empty queue". The whole pipeline was a no-op and
nothing anywhere reported it.

The first test would have caught that: it checks the SQL the worker
actually issues against the column set the migrations actually declare.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

_MIGRATIONS = (
    Path(__file__).resolve().parents[3]
    / "src" / "eden" / "db_migrations" / "versions"
)


def _declared_telemetry_event_columns() -> set[str]:
    """Columns ``telemetry_events`` actually has, per the migrations.

    Parses the ``CREATE TABLE`` in 009 plus every later
    ``ALTER TABLE telemetry_events ADD COLUMN``.
    """
    create_sql = (_MIGRATIONS / "000_squash_001_160.py").read_text()
    body = re.search(
        r"CREATE TABLE IF NOT EXISTS telemetry_events\s*\((.*?)\n\s*\)\s*\"\"\"",
        create_sql,
        re.S,
    )
    assert body, "could not locate the telemetry_events CREATE TABLE in 009"
    columns: set[str] = set()
    for line in body.group(1).splitlines():
        line = line.strip().rstrip(",")
        if not line or line.startswith("--"):
            continue
        name = line.split()[0]
        if name.upper() in {"PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "CONSTRAINT"}:
            continue
        columns.add(name.lower())

    for path in _MIGRATIONS.glob("*.py"):
        text = path.read_text()
        for match in re.finditer(
            r"ALTER TABLE telemetry_events\s+ADD COLUMN(?: IF NOT EXISTS)?\s+"
            r"[\"']?([A-Za-z_][A-Za-z0-9_]*)",
            text,
            re.I,
        ):
            columns.add(match.group(1).lower())
    return columns


def test_migration_009_declares_event_id_and_never_an_id_column():
    """Pins the premise the worker query depends on."""
    columns = _declared_telemetry_event_columns()
    assert "event_id" in columns
    assert "id" not in columns, (
        "telemetry_events has no 'id' column — any query using one is dead code"
    )


class _CapturingClient:
    """Records the SQL issued, returns no rows."""

    def __init__(self) -> None:
        self.queries: list[str] = []
        self.params: list[tuple] = []

    async def fetch(self, sql, *params):
        self.queries.append(sql)
        self.params.append(params)
        return []

    async def fetchrow(self, sql, *params):
        self.queries.append(sql)
        self.params.append(params)
        return None

    async def execute(self, sql, *params):
        self.queries.append(sql)
        self.params.append(params)
        return None


def _install_client(monkeypatch, client):
    import eden.storage.postgres as pg

    async def _get_client():
        return client

    monkeypatch.setattr(pg, "get_postgres_client", _get_client)


def _referenced_telemetry_columns(sql: str) -> set[str]:
    """Column identifiers the SELECT list / cursor predicate uses."""
    found: set[str] = set()
    for select in re.finditer(r"SELECT\s+(.*?)\s+FROM\s+telemetry_events", sql, re.S | re.I):
        for token in select.group(1).split(","):
            token = token.strip()
            if token and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", token):
                found.add(token.lower())
    for pred in re.finditer(r"\(\s*(created_at|event_id|id)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)", sql, re.I):
        found.add(pred.group(1).lower())
        found.add(pred.group(2).lower())
    for pred in re.finditer(r"WHERE\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:::text)?\s*=", sql, re.I):
        found.add(pred.group(1).lower())
    return found


@pytest.mark.asyncio
@pytest.mark.parametrize("since_event_id", [None, "evt-123"])
async def test_poll_query_only_uses_columns_that_exist(monkeypatch, since_event_id):
    """Both branches of the poll must reference only real columns."""
    from eden.observability.quality_pipeline.worker import SidecarWorker

    client = _CapturingClient()
    _install_client(monkeypatch, client)

    rows = await SidecarWorker()._poll_events(since_event_id)
    assert rows == []
    assert client.queries, "no query was issued"

    declared = _declared_telemetry_event_columns()
    for sql in client.queries:
        referenced = _referenced_telemetry_columns(sql)
        assert referenced, f"parsed no columns out of: {sql}"
        unknown = referenced - declared
        assert not unknown, (
            f"query references columns that do not exist on telemetry_events: "
            f"{sorted(unknown)}\nSQL: {sql}"
        )
        assert "event_id" in referenced


@pytest.mark.asyncio
async def test_poll_failure_is_not_silently_reported_as_empty(monkeypatch, caplog):
    """A broken query must be loud — it is indistinguishable from idle."""
    import logging

    from eden.observability.quality_pipeline.worker import SidecarWorker

    class _BrokenClient(_CapturingClient):
        async def fetch(self, sql, *params):
            raise RuntimeError('column "id" does not exist')

    _install_client(monkeypatch, _BrokenClient())
    with caplog.at_level(logging.WARNING):
        rows = await SidecarWorker()._poll_events(None)
    assert rows == []
    assert any(
        r.levelno >= logging.WARNING for r in caplog.records
    ), "a failing poll must warn, not hide behind logger.debug"


# ── Watermark: one upserted row, DDL once per process ──────────────


@pytest.mark.asyncio
async def test_save_watermark_upserts_instead_of_appending(monkeypatch):
    from eden.observability.quality_pipeline import worker as worker_module

    worker_module._reset_watermark_caches_for_tests()
    client = _CapturingClient()
    _install_client(monkeypatch, client)

    await worker_module.save_watermark("tenant-a", "evt-1")
    await worker_module.save_watermark("tenant-a", "evt-2")

    inserts = [q for q in client.queries if "INSERT INTO quality_pipeline_watermark" in q]
    assert len(inserts) == 2
    for sql in inserts:
        assert "ON CONFLICT" in sql.upper(), (
            "watermark must upsert a single row, not append one per batch"
        )


@pytest.mark.asyncio
async def test_watermark_ddl_runs_once_per_process(monkeypatch):
    from eden.observability.quality_pipeline import worker as worker_module

    worker_module._reset_watermark_caches_for_tests()
    client = _CapturingClient()
    _install_client(monkeypatch, client)

    await worker_module.load_watermark()
    await worker_module.load_watermark()
    await worker_module.save_watermark("tenant-a", "evt-1")

    ddl = [q for q in client.queries if "CREATE TABLE IF NOT EXISTS" in q]
    assert len(ddl) == 1, (
        f"CREATE TABLE should run once per process, ran {len(ddl)}x"
    )


@pytest.mark.asyncio
async def test_legacy_append_rows_are_pruned_once(monkeypatch):
    from eden.observability.quality_pipeline import worker as worker_module

    worker_module._reset_watermark_caches_for_tests()
    client = _CapturingClient()
    _install_client(monkeypatch, client)

    await worker_module.save_watermark("tenant-a", "evt-1")
    await worker_module.save_watermark("tenant-a", "evt-2")

    deletes = [q for q in client.queries if q.strip().upper().startswith("DELETE")]
    assert len(deletes) == 1, "legacy prune should happen exactly once per process"


@pytest.mark.asyncio
async def test_load_watermark_prefers_most_recent_write(monkeypatch):
    """Ordering must survive legacy rows with higher serial ids."""
    from eden.observability.quality_pipeline import worker as worker_module

    worker_module._reset_watermark_caches_for_tests()
    client = _CapturingClient()
    _install_client(monkeypatch, client)

    await worker_module.load_watermark()
    selects = [q for q in client.queries if "SELECT tenant_id, event_id" in q]
    assert selects
    assert "ORDER BY updated_at DESC" in selects[0]
