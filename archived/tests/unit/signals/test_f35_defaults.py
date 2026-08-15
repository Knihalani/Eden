"""F35 — default signal library templates + seed helpers."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import pytest

from eden.signals.defaults import (
    DEFAULT_SIGNALS,
    PROFILE_SIGNALS,
    seed_org_signals,
    templates_for_profile,
)


def test_default_library_has_eight_templates() -> None:
    assert len(DEFAULT_SIGNALS) == 8
    assert set(PROFILE_SIGNALS["advanced"]) == {t.id for t in DEFAULT_SIGNALS}


def test_standard_profile_subset() -> None:
    ids = {t.id for t in templates_for_profile("standard")}
    assert "forgetting" in ids
    assert "jailbreak_attempt" not in ids
    assert "looping" in ids


@pytest.mark.asyncio
async def test_seed_org_signals_inserts_and_skips_dupes() -> None:
    executed: list[tuple[Any, ...]] = []

    class FakePg:
        def __init__(self) -> None:
            self._rows: list[dict[str, Any]] = []

        async def fetch(self, *_a: Any, **_k: Any) -> list[dict[str, Any]]:
            return list(self._rows)

        async def execute(self, *_a: Any, **kwargs: Any) -> None:
            # asyncpg-style positional args after SQL
            args = _a[1:] if _a else ()
            executed.append(args)
            # description is arg index 2 (0=id,1=org,2=desc)
            if len(args) >= 3:
                self._rows.append({"description": args[2], "cluster_id": args[6] if len(args) > 6 else ""})

    pg = FakePg()
    first = await seed_org_signals("org_1", profile="minimal", pg=pg)
    assert first.count == 2
    assert first.skipped == 0
    second = await seed_org_signals("org_1", profile="minimal", pg=pg)
    assert second.count == 0
    assert second.skipped == 2


@pytest.mark.asyncio
async def test_seed_org_signals_inserts_eight_on_advanced_profile() -> None:
    executed: list[tuple[Any, ...]] = []

    class FakePg:
        def __init__(self) -> None:
            self._rows: list[dict[str, Any]] = []

        async def fetch(self, *_a: Any, **_k: Any) -> list[dict[str, Any]]:
            return list(self._rows)

        async def execute(self, sql: str, *args: Any, **kwargs: Any) -> None:
            executed.append((sql, args))

    pg = FakePg()
    result = await seed_org_signals("org_adv", profile="advanced", pg=pg)
    assert result.count == 8
    nl_inserts = [a for sql, a in executed if "INSERT INTO nl_signals" in sql]
    def_inserts = [a for sql, a in executed if "INSERT INTO signal_definitions" in sql]
    assert len(nl_inserts) == 8
    assert len(def_inserts) == 8


@pytest.mark.asyncio
async def test_seed_missing_table_returns_zero() -> None:
    pg = AsyncMock()
    pg.fetch = AsyncMock(side_effect=Exception("relation nl_signals does not exist"))
    result = await seed_org_signals("org_x", profile="standard", pg=pg)
    assert result.count == 0
    assert result.skipped == len(PROFILE_SIGNALS["standard"])
