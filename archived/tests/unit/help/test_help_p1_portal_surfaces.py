"""P1.5 portal leftover rollup: per-surface counts, not one blended help %."""

from __future__ import annotations

import inspect
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.integrations.slack.store import leftover_by_surface, list_leftover_events


def _hit(surface: str, *, polarity: str = "extra_work") -> dict:
    return {"surface": surface, "polarity": polarity, "kind": "human_did_agents_job"}


def test_slack_and_linear_are_two_counts_not_an_average() -> None:
    counts = leftover_by_surface(
        [_hit("slack")] * 3 + [_hit("linear")] * 2
    )
    assert counts == {"slack": 3, "linear": 2}
    assert "help_rate" not in counts
    assert sum(counts.values()) == 5
    # Do not blend into one leftover percent.
    assert all(isinstance(v, int) for v in counts.values())


def test_unfired_surfaces_are_absent_not_zero() -> None:
    counts = leftover_by_surface([_hit("slack"), _hit("jira")])
    assert counts == {"slack": 1, "jira": 1}
    for missing in ("linear", "github", "intercom", "zendesk", "webhook"):
        assert missing not in counts


def test_unknown_and_empty_surfaces_omitted() -> None:
    counts = leftover_by_surface(
        [
            _hit("salesforce"),
            _hit(""),
            _hit("   "),
            {"polarity": "extra_work"},
            _hit("slack"),
        ]
    )
    assert counts == {"slack": 1}


def test_webhook_surface_counted_when_it_fires() -> None:
    counts = leftover_by_surface([_hit("webhook"), _hit("webhook"), _hit("github")])
    assert counts == {"webhook": 2, "github": 1}


def test_non_extra_work_polarity_omitted() -> None:
    counts = leftover_by_surface(
        [
            _hit("slack", polarity="not_extra_work"),
            _hit("linear", polarity="unscored"),
            _hit("jira", polarity="extra_work"),
        ]
    )
    assert counts == {"jira": 1}


def test_list_leftover_events_default_limit_is_20() -> None:
    sig = inspect.signature(list_leftover_events)
    assert sig.parameters["limit"].default == 20


@pytest.mark.asyncio
async def test_list_leftover_events_passes_limit_20() -> None:
    client = MagicMock()
    client.fetch = AsyncMock(return_value=[])
    with patch("eden.integrations.slack.store._pg", AsyncMock(return_value=client)):
        await list_leftover_events("org1", agent_id="ag")
    args = client.fetch.await_args.args
    assert args[-1] == 20
    assert "LIMIT" in args[0]


@pytest.mark.asyncio
async def test_help_counts_groups_by_surface_no_help_rate() -> None:
    from eden.integrations.slack import store as slack_store

    session_rows = [
        {"helped": "helped", "n": 4},
        {"helped": "not_helped", "n": 3},
        {"helped": "unknown", "n": 12},
    ]
    surface_rows = [
        {"surface": "slack", "n": 3},
        {"surface": "linear", "n": 2},
        {"surface": "salesforce", "n": 9},
        {"surface": "jira", "n": 0},
    ]
    client = MagicMock()
    client.fetch = AsyncMock(side_effect=[session_rows, surface_rows])
    with patch.object(slack_store, "_pg", AsyncMock(return_value=client)):
        out = await slack_store.help_counts("org1", agent_id="ag")
    assert out["helped"] == 4
    assert out["not_helped"] == 3
    assert out["unknown"] == 12
    assert out["by_surface"] == {"slack": 3, "linear": 2}
    assert out["leftover_7d"] == 5
    assert "help_rate" not in out
    sql = client.fetch.await_args_list[1].args[0]
    assert "GROUP BY surface" in sql
    assert "extra_work_events" in sql
    assert "polarity = 'extra_work'" in sql


def test_help_panel_shows_by_surface_counts_not_a_rate() -> None:
    panel = Path("clients/portal/src/app/(portal)/agents/help-panel.tsx").read_text()
    assert "by_surface" in panel
    assert "help_rate" not in panel
    assert "helpRate" not in panel
    assert "leftoverSurfaces" in panel
    # No glossy leftover / help percentage on /agents (P2, n >= 20).
    assert "%" not in panel
    route = Path("src/eden/api/routes/agent_sessions.py").read_text()
    assert "limit=20" in route
    assert "help_rate" not in route
