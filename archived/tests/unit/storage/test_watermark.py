"""Unit tests for ``eden.storage.watermark`` (OPT-3).

``fetch_stale_candidates`` / ``advance_watermark`` are the generic
oldest-processed-first idiom that replaced ``auto_curator``'s
unwatermarked ``SELECT ... LIMIT 50`` — no ``ORDER BY``, so the same
stable-but-arbitrary 50 orgs ran forever while everything past row 50
was silently starved (never errored, never paged).

Two layers of coverage:

* Call-shape tests against a ``MagicMock`` pg client — the SQL text and
  the positional-argument calling convention (``$1`` = limit for
  fetch, ``$1`` = entity id for execute) callers depend on.
* A ``_FakePg`` that actually implements the left-join / ``ORDER BY
  ... NULLS FIRST`` / ``LIMIT`` semantics in Python, proving the FIFO
  drain + "previously-excluded rows surface on a later call" property
  end-to-end without a live Postgres.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

from eden.storage.watermark import advance_watermark, fetch_stale_candidates


async def test_fetch_stale_candidates_passes_limit_positionally():
    pg = MagicMock()
    pg.fetch = AsyncMock(return_value=[{"org_id": "org-1"}])

    out = await fetch_stale_candidates(
        pg,
        candidate_table="organizations",
        watermark_table="auto_curator_watermark",
        limit=7,
    )

    assert out == [{"org_id": "org-1"}]
    query, limit_arg = pg.fetch.await_args.args
    assert limit_arg == 7
    assert "FROM organizations" in query
    assert "LEFT JOIN auto_curator_watermark" in query
    assert "ORDER BY w.last_processed_at ASC NULLS FIRST" in query
    assert "LIMIT $1" in query


async def test_advance_watermark_upserts_now_for_entity():
    pg = MagicMock()
    pg.execute = AsyncMock(return_value="INSERT 0 1")

    await advance_watermark(
        pg, watermark_table="auto_curator_watermark", entity_id="org-9"
    )

    query, entity_arg = pg.execute.await_args.args
    assert entity_arg == "org-9"
    assert "INSERT INTO auto_curator_watermark" in query
    assert "ON CONFLICT (org_id) DO UPDATE" in query
    assert "NOW()" in query


class _FakePg:
    """Minimal in-Python stand-in implementing the real join/order/limit.

    Not a SQL engine — ``.fetch`` ignores the query text and directly
    implements "left join candidates against the watermark dict, order
    by watermark ASC NULLS FIRST, take ``limit``" so this test proves
    the *selection algorithm*, not just that some string got sent to
    asyncpg.
    """

    def __init__(self, candidate_ids: list[str]) -> None:
        self.candidate_ids = candidate_ids
        self.watermark: dict[str, float] = {}
        self._clock = 0.0

    async def fetch(self, _query: str, limit: int):
        def sort_key(oid: str) -> tuple[int, float]:
            ts = self.watermark.get(oid)
            # NULLS FIRST: a never-processed org (no watermark row) sorts
            # ahead of every already-processed org.
            return (0, 0.0) if ts is None else (1, ts)

        ordered = sorted(self.candidate_ids, key=sort_key)
        return [{"org_id": oid} for oid in ordered[:limit]]

    async def execute(self, _query: str, entity_id: str):
        self._clock += 1.0
        self.watermark[entity_id] = self._clock
        return "INSERT 0 1"


async def test_watermark_drains_fifo_and_previously_excluded_orgs_surface():
    """The property the fix exists for.

    A bare ``LIMIT 3`` with no ``ORDER BY`` would return the *same*
    three orgs on every call, forever. With the watermark, each
    processed batch sorts to the back, so later calls surface the orgs
    a naive ``LIMIT`` would have starved permanently.
    """
    orgs = [f"org-{i}" for i in range(10)]
    pg = _FakePg(orgs)

    seen_batches: list[list[str]] = []
    for _ in range(4):  # 10 orgs / batch of 3 -> 4 calls covers everyone once and wraps
        rows = await fetch_stale_candidates(
            pg,
            candidate_table="organizations",
            watermark_table="auto_curator_watermark",
            limit=3,
        )
        batch = [r["org_id"] for r in rows]
        seen_batches.append(batch)
        for oid in batch:
            await advance_watermark(
                pg, watermark_table="auto_curator_watermark", entity_id=oid
            )

    # The first three calls are disjoint: every org gets covered before
    # any repeats. The bug this replaces would instead return
    # `seen_batches[0]` unchanged on every single call.
    first_nine = seen_batches[0] + seen_batches[1] + seen_batches[2]
    assert sorted(first_nine) == sorted(orgs[:9])
    assert len(set(first_nine)) == 9

    # Orgs a naive `LIMIT 3` would have excluded forever (everything
    # past org-2) do show up in a later batch.
    naive_limit_3 = set(seen_batches[0])
    later_batches = set(seen_batches[1]) | set(seen_batches[2]) | set(seen_batches[3])
    assert later_batches - naive_limit_3, (
        "orgs excluded by a plain LIMIT 3 never surfaced in a later batch"
    )

    # The never-advanced org (org-9, still NULL) leads the 4th batch —
    # NULLS FIRST beats every already-processed org regardless of how
    # long ago it was processed.
    assert seen_batches[3][0] == "org-9"


async def test_fetch_stale_candidates_composite_key_builds_positional_join():
    """Composite (multi-column) key shape used by OPT-7/OPT-8.

    ``candidate_id_column``/``watermark_id_column``/``id_alias`` passed as
    equal-length sequences must join positionally (each pair AND-joined)
    and select each aliased column, still binding ``limit`` as the sole
    ``$1`` placeholder.
    """
    pg = MagicMock()
    pg.fetch = AsyncMock(return_value=[{"org_id": "org-1", "signal_id": "sig-1"}])

    out = await fetch_stale_candidates(
        pg,
        candidate_table="(SELECT DISTINCT org_id, signal_id FROM signal_events)",
        watermark_table="classifier_retrain_watermark",
        candidate_id_column=("org_id", "signal_id"),
        watermark_id_column=("org_id", "signal_id"),
        id_alias=("org_id", "signal_id"),
        limit=50,
    )

    assert out == [{"org_id": "org-1", "signal_id": "sig-1"}]
    query, limit_arg = pg.fetch.await_args.args
    assert limit_arg == 50
    assert "c.org_id::text AS org_id" in query
    assert "c.signal_id::text AS signal_id" in query
    assert "w.org_id = c.org_id AND w.signal_id = c.signal_id" in query
    assert "LEFT JOIN classifier_retrain_watermark" in query
    assert "LIMIT $1" in query


async def test_fetch_stale_candidates_mismatched_composite_lengths_raise():
    pg = MagicMock()

    try:
        await fetch_stale_candidates(
            pg,
            candidate_table="agent_issues",
            watermark_table="drift_baseline_watermark",
            candidate_id_column=("org_id", "agent_id"),
            watermark_id_column=("org_id",),
            id_alias=("org_id", "agent_id"),
        )
    except ValueError as exc:
        assert "same number of columns" in str(exc)
    else:
        raise AssertionError("expected ValueError for mismatched column counts")


async def test_advance_watermark_composite_key_binds_positional_ids_no_cast():
    """OPT-8's ``(org_id, agent_id)`` pair: VARCHAR columns, ``id_cast=None``.

    Unlike the default single-column ``id_cast="uuid"`` shape, a composite
    key with ``id_cast=None`` must bind both ids positionally with no
    ``::uuid`` cast on either placeholder, and upsert on the composite
    conflict target.
    """
    pg = MagicMock()
    pg.execute = AsyncMock(return_value="INSERT 0 1")

    await advance_watermark(
        pg,
        watermark_table="drift_baseline_watermark",
        entity_id=("org-1", "agent-1"),
        watermark_id_column=("org_id", "agent_id"),
        id_cast=None,
    )

    query, org_arg, agent_arg = pg.execute.await_args.args
    assert (org_arg, agent_arg) == ("org-1", "agent-1")
    assert "INSERT INTO drift_baseline_watermark (org_id, agent_id" in query
    assert "VALUES ($1, $2, NOW())" in query
    assert "ON CONFLICT (org_id, agent_id) DO UPDATE" in query


async def test_advance_watermark_composite_key_default_uuid_cast_per_column():
    """OPT-7's ``(org_id, signal_id)`` pair: default ``id_cast="uuid"``
    broadcasts to every column when a single string is given (not just
    the single-column shape)."""
    pg = MagicMock()
    pg.execute = AsyncMock(return_value="INSERT 0 1")

    await advance_watermark(
        pg,
        watermark_table="classifier_retrain_watermark",
        entity_id=("org-1", "sig-1"),
        watermark_id_column=("org_id", "signal_id"),
    )

    query, *_ = pg.execute.await_args.args
    assert "VALUES ($1::uuid, $2::uuid, NOW())" in query


async def test_advance_watermark_entity_id_length_mismatch_raises():
    pg = MagicMock()

    try:
        await advance_watermark(
            pg,
            watermark_table="drift_baseline_watermark",
            entity_id=("org-1",),
            watermark_id_column=("org_id", "agent_id"),
        )
    except ValueError as exc:
        assert "one value per watermark_id_column" in str(exc)
    else:
        raise AssertionError("expected ValueError for mismatched entity_id length")
