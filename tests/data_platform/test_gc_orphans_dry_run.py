"""``gc_orphans`` must honour dry-run, and must not sweep live or archived rows.

Regression lock for the 2026-07 remediation.

``retention_cron`` called ``get_message_store().gc_orphans()`` with no
arguments, and the method had no dry-run support at all — so running
``python -m eden.data_platform.retention_cron``, whose CLI *defaults* to
``--dry-run``, permanently deleted ``trace_messages`` rows. Those rows hold the
prompt and completion text; after the archive path deletes the events, they are
the only remaining copy.

The anti-join was also unguarded: no age floor (so a trace whose events had not
landed yet looked orphaned) and no ``trace_archive_index`` exclusion (so the
live copy of an archived trace was a deletion candidate).
"""

from __future__ import annotations

from typing import Any

import pytest

from eden.observability.message_store import MessageStore


class _RecordingClient:
    """Captures every statement so tests can assert on shape, not call counts."""

    def __init__(self, rows: list[dict[str, str]]) -> None:
        self._rows = rows
        self.queries: list[str] = []
        self.args: list[tuple[Any, ...]] = []

    async def fetch(self, query: str, *args: Any) -> list[dict[str, str]]:
        self.queries.append(query)
        self.args.append(args)
        return self._rows

    async def execute(self, query: str, *args: Any) -> str:
        self.queries.append(query)
        self.args.append(args)
        return f"DELETE {len(self._rows)}"

    @property
    def deletes(self) -> list[str]:
        return [q for q in self.queries if "DELETE" in q.upper()]


def _store(client: _RecordingClient) -> MessageStore:
    store = MessageStore()

    async def _get_client() -> _RecordingClient:
        return client

    store._get_client = _get_client  # type: ignore[method-assign,assignment]
    return store


@pytest.mark.asyncio
async def test_dry_run_is_the_default_and_issues_no_delete() -> None:
    """The dangerous default. A caller passing nothing must not delete."""
    client = _RecordingClient([{"trace_id": "t1"}, {"trace_id": "t2"}])

    deleted = await _store(client).gc_orphans()

    assert client.deletes == [], "dry-run issued a DELETE"
    assert deleted == 2, "dry-run should still report what it would delete"


@pytest.mark.asyncio
async def test_explicit_dry_run_false_does_delete() -> None:
    """The safety must be opt-out, not a permanent no-op."""
    client = _RecordingClient([{"trace_id": "t1"}])

    deleted = await _store(client).gc_orphans(dry_run=False)

    assert len(client.deletes) == 1
    assert deleted == 1


@pytest.mark.asyncio
async def test_query_excludes_archived_traces() -> None:
    """Archived messages are the only copy of the text — never sweep them."""
    client = _RecordingClient([])
    await _store(client).gc_orphans(dry_run=True)

    select = client.queries[0]
    assert "trace_archive_index" in select, (
        "the anti-join no longer excludes archived traces; this sweep would "
        "delete the live copy of text whose archive is the only backup"
    )


@pytest.mark.asyncio
async def test_query_has_an_age_floor_on_the_real_column() -> None:
    """A trace whose events have not landed yet must not look orphaned.

    Asserts ``first_seen_at`` specifically: ``trace_messages`` has no
    ``created_at`` column, and naming one would fail at runtime and be
    swallowed by the caller's ``except``.
    """
    client = _RecordingClient([])
    await _store(client).gc_orphans(dry_run=True, min_age_days=7)

    select = client.queries[0]
    assert "first_seen_at" in select
    assert "created_at" not in select, "trace_messages has no created_at column"
    assert client.args[0][1] == "7"


@pytest.mark.asyncio
async def test_no_org_id_parameter_is_accepted() -> None:
    """trace_messages has no tenant column; a scoped sweep is not expressible."""
    client = _RecordingClient([])
    with pytest.raises(TypeError):
        await _store(client).gc_orphans(org_id="org-a")  # type: ignore[call-arg]
