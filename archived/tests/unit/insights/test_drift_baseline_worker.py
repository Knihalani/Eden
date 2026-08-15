"""Unit tests for ``eden.insights.drift_baseline_worker`` (OPT-8).

``DriftBaselineWorker.run_once`` used to select its weekly (org_id,
agent_id) batch with a bare ``SELECT DISTINCT ... LIMIT $1`` — no
``ORDER BY``, no watermark — so the same stable-but-arbitrary subset of
pairs won every tick forever while everything past the limit starved
silently (the same defect class OPT-3 fixed for ``auto_curator``, see
``tests/unit/storage/test_watermark.py``).

These tests exercise the fix end-to-end against a fake Postgres client
that implements the real left-join / ``ORDER BY ... NULLS FIRST`` /
``LIMIT`` semantics of ``eden.storage.watermark.fetch_stale_candidates``
for the synthetic ``org_agent_key`` composite key (migration
147_drift_baseline_watermark), proving:

* candidates cycle through the full pair space instead of repeating,
  and previously-excluded pairs surface on a later run; and
* the watermark advances exactly once per (org_id, agent_id) pair,
  after its whole ``DRIFT_DIMENSIONS`` loop finishes — not once per
  dimension.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

from eden.insights.drift_baseline_worker import (
    _DRIFT_BASELINE_CONCURRENCY,
    DriftBaselineWorker,
    _org_agent_key,
)
from eden.insights.drift_reports import DRIFT_DIMENSIONS, DriftReportBuilder


class _FakePg:
    """In-Python stand-in implementing the query ``run_once`` issues.

    ``.fetch`` ignores the actual SQL text's join mechanics and instead
    directly implements "left join candidate pairs against the
    watermark dict, order by watermark ASC NULLS FIRST, take limit,
    also return the org_id/agent_id extra_columns" for the
    ``fetch_stale_candidates`` call — the single query
    ``drift_baseline_worker.py`` sends per run.
    """

    def __init__(self, pairs: list[tuple[str, str]]) -> None:
        self.pairs = pairs
        self.watermark: dict[str, float] = {}
        self._clock = 0.0
        self.execute_calls: list[str] = []

    async def fetch(self, query: str, *args):
        assert "LEFT JOIN drift_baseline_watermark" in query
        (limit,) = args

        def sort_key(pair: tuple[str, str]) -> tuple[int, float]:
            key = _org_agent_key(*pair)
            ts = self.watermark.get(key)
            return (0, 0.0) if ts is None else (1, ts)

        ordered = sorted(self.pairs, key=sort_key)
        return [
            {"org_agent_key": _org_agent_key(*p), "org_id": p[0], "agent_id": p[1]}
            for p in ordered[:limit]
        ]

    async def execute(self, query: str, *args):
        assert "INSERT INTO drift_baseline_watermark" in query
        # advance_watermark binds the genuine two-column composite key
        # (org_id, agent_id) as two separate parameters — see
        # eden.storage.watermark.advance_watermark — so args is a pair,
        # not a single combined value. Collapse to one key here (the
        # same key format fetch()'s sort_key uses) purely for this
        # fake's own bookkeeping.
        org_id, agent_id = args
        entity_id = _org_agent_key(org_id, agent_id)
        self.execute_calls.append(entity_id)
        self._clock += 1.0
        self.watermark[entity_id] = self._clock
        return "INSERT 0 1"


def _patched_client(pg: _FakePg):
    async def _get_client():
        return pg

    return patch("eden.storage.postgres.get_postgres_client", side_effect=_get_client)


async def test_candidates_cycle_instead_of_repeating_forever():
    """The property the fix exists for.

    A bare ``LIMIT 3`` with no watermark would return the *same* three
    (org_id, agent_id) pairs on every weekly tick, forever. With the
    watermark wired in, each processed pair sorts to the back, so a
    later run surfaces pairs a naive ``LIMIT`` would have starved.
    """
    pairs = [(f"org-{i}", f"agent-{i}") for i in range(9)]
    pg = _FakePg(pairs)
    worker = DriftBaselineWorker()
    worker._histogram = AsyncMock(return_value=[1.0] * 10)

    seen_batches: list[set[tuple[str, str]]] = []
    with (
        _patched_client(pg),
        patch.object(DriftReportBuilder, "upsert_baseline", AsyncMock()) as upsert,
    ):
        for _ in range(4):  # 9 pairs / batch of 3 -> 3 disjoint runs + a 4th that wraps
            before = set(pg.execute_calls)
            await worker.run_once(limit=3)
            after_keys = [k for k in pg.execute_calls if k not in before]
            batch = {
                (org_id, agent_id)
                for org_id, agent_id in pairs
                if _org_agent_key(org_id, agent_id) in after_keys
            }
            seen_batches.append(batch)

    # Each run's batch of 3 gets a full dimension pass, including the 4th
    # run's wraparound repeats — 4 runs * 3 pairs each = 12 pair-passes.
    assert upsert.await_count == 12 * len(DRIFT_DIMENSIONS)

    # First three runs are disjoint: every pair gets covered before any
    # repeats. The bug this replaces would return seen_batches[0] again
    # on every single run instead.
    first_nine = seen_batches[0] | seen_batches[1] | seen_batches[2]
    assert first_nine == set(pairs)

    # Pairs a naive `LIMIT 3` would have starved forever (everything
    # past the first three) do show up in a later run.
    naive_limit_3 = seen_batches[0]
    later_runs = seen_batches[1] | seen_batches[2] | seen_batches[3]
    assert later_runs - naive_limit_3, (
        "pairs excluded by a plain LIMIT 3 never surfaced in a later run"
    )


async def test_watermark_advances_once_per_pair_after_full_dimension_loop():
    """advance_watermark must fire once per pair, post-loop — not per-dimension."""
    pairs = [("org-a", "agent-a"), ("org-b", "agent-b")]
    pg = _FakePg(pairs)
    worker = DriftBaselineWorker()
    worker._histogram = AsyncMock(return_value=[1.0] * 10)

    with (
        _patched_client(pg),
        patch.object(DriftReportBuilder, "upsert_baseline", AsyncMock()) as upsert,
    ):
        result = await worker.run_once(limit=10)

    # 2 pairs * 7 dimensions of upserts, but only 2 watermark advances.
    assert upsert.await_count == 2 * len(DRIFT_DIMENSIONS)
    assert len(pg.execute_calls) == 2
    assert result["updated"] == 2 * len(DRIFT_DIMENSIONS)

    expected_keys = {_org_agent_key(*p) for p in pairs}
    assert set(pg.execute_calls) == expected_keys


async def test_watermark_advances_even_when_dimension_loop_raises():
    """A poison pair must still advance so it doesn't wedge the queue forever."""
    pairs = [("org-poison", "agent-poison")]
    pg = _FakePg(pairs)
    worker = DriftBaselineWorker()
    worker._histogram = AsyncMock(side_effect=RuntimeError("boom"))

    with _patched_client(pg):
        result = await worker.run_once(limit=10)

    # The outer try/except in run_once swallows the exception; the watermark
    # for the poison pair must still have advanced via the finally block.
    assert result == {"updated": 0}
    assert pg.execute_calls == [_org_agent_key(*pairs[0])]


async def test_poison_pair_does_not_block_remaining_pairs_in_same_batch():
    """A failure on one pair must not skip every pair queued behind it.

    ``_histogram`` raising for one (org_id, agent_id) pair must be isolated
    to that pair: the per-pair ``except`` must catch it before it escapes
    the ``for row in rows`` loop, otherwise every remaining pair in the
    same ``run_once`` batch would silently go unprocessed *and*
    un-watermarked — re-creating the starvation bug this fix exists to
    close, just one layer up.
    """
    pairs = [("org-poison", "agent-poison"), ("org-ok", "agent-ok")]
    pg = _FakePg(pairs)
    worker = DriftBaselineWorker()

    async def _histogram(org_id: str, agent_id: str, dimension: str):
        if org_id == "org-poison":
            raise RuntimeError("boom")
        return [1.0] * 10

    worker._histogram = AsyncMock(side_effect=_histogram)

    with (
        _patched_client(pg),
        patch.object(DriftReportBuilder, "upsert_baseline", AsyncMock()) as upsert,
    ):
        result = await worker.run_once(limit=10)

    # Both pairs get their watermark advanced — the poison pair via the
    # ``finally`` block, the healthy pair via normal completion.
    assert set(pg.execute_calls) == {
        _org_agent_key(*pairs[0]),
        _org_agent_key(*pairs[1]),
    }
    # The healthy pair still completes its full dimension pass despite the
    # poison pair failing first.
    assert upsert.await_count == len(DRIFT_DIMENSIONS)
    assert result["updated"] == len(DRIFT_DIMENSIONS)


async def test_dimension_pass_uses_bounded_gather_with_concurrency_cap():
    """OPT-25: per-pair dimension histograms overlap under bounded_gather."""
    pairs = [("org-a", "agent-a")]
    pg = _FakePg(pairs)
    worker = DriftBaselineWorker()
    worker._histogram = AsyncMock(return_value=[1.0] * 10)
    gather_limits: list[int] = []

    async def _fake_gather(*aws, limit=None, return_exceptions=False):
        gather_limits.append(limit)
        return [await aw for aw in aws]

    with (
        _patched_client(pg),
        patch.object(DriftReportBuilder, "upsert_baseline", AsyncMock()) as upsert,
        patch(
            "eden.async_tasks.bounded_gather",
            side_effect=_fake_gather,
        ),
    ):
        await worker.run_once(limit=10)

    # Outer pair batch + inner dimension batch both use the same cap.
    assert gather_limits == [_DRIFT_BASELINE_CONCURRENCY, _DRIFT_BASELINE_CONCURRENCY]
    assert upsert.await_count == len(DRIFT_DIMENSIONS)
