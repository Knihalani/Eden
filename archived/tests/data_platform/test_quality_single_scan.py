"""Each expectation evaluates in one table scan, not two.

Every expectation type issued two queries against the same table and WHERE:

    unexpected = await client.fetchval(f"SELECT COUNT(*) ... <predicate>")
    total      = await client.fetchval(f"SELECT COUNT(*) FROM {t} {where}")

The second was byte-identical across all five types, so a suite of N
expectations ran N identical full-table counts on top of its N predicate counts.
``COUNT(*) FILTER (WHERE ...)`` returns both from one scan — exactly half, by
construction rather than by estimate.

Counting queries rather than timing them: the improvement is structural, so the
assertion should be too. A timing test here would measure the fake client.
"""

from __future__ import annotations

from typing import Any

import pytest

from eden.data_platform.quality import (
    DataQualityValidator,
    Expectation,
)


class _CountingClient:
    """Records every statement, answers counts from a fixed row population."""

    def __init__(self, total: int = 100, unexpected: int = 7) -> None:
        self.total = total
        self.unexpected = unexpected
        self.queries: list[str] = []

    async def fetchval(self, query: str, *args: Any) -> Any:
        self.queries.append(" ".join(query.split()))
        return self.total

    async def fetchrow(self, query: str, *args: Any) -> Any:
        self.queries.append(" ".join(query.split()))
        return {"total": self.total, "unexpected": self.unexpected}

    def scans(self) -> int:
        return sum(1 for q in self.queries if "COUNT(" in q.upper())


@pytest.fixture
def validator() -> DataQualityValidator:
    return DataQualityValidator()


CASES = [
    (Expectation.EXPECT_NOT_NULL, {"column": "org_id"}),
    (Expectation.EXPECT_UNIQUE, {"column": "event_id"}),
    (
        Expectation.EXPECT_BETWEEN,
        {"column": "duration_ms", "min_value": 0, "max_value": 60000},
    ),
    (Expectation.EXPECT_REGEX, {"column": "email", "regex": ".+@.+"}),
    (
        Expectation.EXPECT_IN_SET,
        {"column": "outcome", "value_set": ["ok", "error"]},
    ),
]


def _expectation(etype: str, kwargs: dict[str, Any]) -> Expectation:
    return Expectation(
        name=f"probe_{etype}", expectation_type=etype, kwargs=dict(kwargs)
    )


@pytest.mark.parametrize("etype,kwargs", CASES, ids=[c[0] for c in CASES])
@pytest.mark.asyncio
async def test_each_expectation_uses_one_scan(
    validator: DataQualityValidator,
    monkeypatch: pytest.MonkeyPatch,
    etype: str,
    kwargs: dict[str, Any],
) -> None:
    client = _CountingClient()
    monkeypatch.setattr(
        "eden.storage.postgres.get_postgres_client",
        lambda: _resolved(client),
    )
    result = await validator._evaluate_expectation(
        client, "telemetry_events", _expectation(etype, kwargs)
    )
    assert result is not None
    assert client.scans() == 1, (
        f"{etype} issued {client.scans()} counting queries: "
        f"{client.queries}. It should take the total and the unexpected count "
        "from a single scan."
    )


@pytest.mark.asyncio
async def test_the_percentage_still_uses_the_real_total(
    validator: DataQualityValidator, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The combined query must not change the reported ratio."""
    client = _CountingClient(total=200, unexpected=50)
    monkeypatch.setattr(
        "eden.storage.postgres.get_postgres_client", lambda: _resolved(client)
    )
    result = await validator._evaluate_expectation(
        client,
        "telemetry_events",
        _expectation(Expectation.EXPECT_NOT_NULL, {"column": "org_id"}),
    )
    assert result.unexpected_count == 50
    assert result.unexpected_percent == pytest.approx(25.0), (
        f"expected 50/200 = 25%, got {result.unexpected_percent}"
    )


@pytest.mark.asyncio
async def test_a_zero_row_table_does_not_divide_by_zero(
    validator: DataQualityValidator, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Empty tables report percent 0.0 without inventing a phantom row."""
    client = _CountingClient(total=0, unexpected=0)
    monkeypatch.setattr(
        "eden.storage.postgres.get_postgres_client", lambda: _resolved(client)
    )
    result = await validator._evaluate_expectation(
        client,
        "telemetry_events",
        _expectation(Expectation.EXPECT_NOT_NULL, {"column": "org_id"}),
    )
    assert result.unexpected_count == 0
    assert result.unexpected_percent == 0.0
    assert result.success is True


def test_no_expectation_branch_reissues_the_total(monkeypatch) -> None:
    """Source guard: the duplicated total query must not reappear.

    Five separate branches each carried the same
    ``SELECT COUNT(*) FROM {table_name} {where}`` line, so re-adding one is a
    plausible edit. The behavioural tests above cover the branches that exist
    today; this catches a sixth being written the old way.
    """
    from pathlib import Path

    src = (
        Path(__file__).resolve().parents[2] / "src/eden/data_platform/quality.py"
    ).read_text()
    dupes = src.count(
        'await client.fetchval(f"SELECT COUNT(*) FROM {table_name} {where}")'
    )
    assert dupes == 0, (
        f"{dupes} expectation branch(es) still issue a separate total count; "
        "use _count_total_and_unexpected so it comes from the same scan"
    )


def _resolved(value: Any) -> Any:
    async def _inner() -> Any:
        return value

    return _inner()
