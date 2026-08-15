"""BUG-6 — Agents dashboard must not split a registered agent into a
"ghost card" when telemetry stamps a raw framework-instrumentation label
(e.g. ``pydantic-ai:OpenAIChatModel()``) instead of the registered
``agent_id``.

Repro this guards: a trace's events never carry the registered agent_id at
all (so ``_PREFERRED_AGENT_ID_SQL`` cannot resolve a winner *within the
current window*), but a prior window's traces did co-occur both labels and
that pairing was persisted to ``agent_identity_aliases``. The merge logic
in ``list_portal_agents`` must resolve the synthetic label through that
table and fold its metrics into the registered card instead of emitting a
second, unrecognizable card.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.api.routes import portal as portal_mod

SYNTHETIC_LABEL = "pydantic-ai:OpenAIChatModel()"
REGISTERED_ID = "checkout-agent"


class _FakeClient:
    """Minimal stand-in for the asyncpg wrapper, routed by SQL shape."""

    def __init__(self, *, alias_pairs=None, persisted_aliases=None):
        self._alias_pairs = alias_pairs or []
        self._persisted_aliases = persisted_aliases or {}
        self.executed: list[tuple[str, tuple]] = []

    async def fetch(self, query: str, *args):
        if "FROM agent_registrations" in query:
            return [
                {
                    "agent_id": REGISTERED_ID,
                    "name": "Checkout Agent",
                    "framework": "python-sdk",
                    "repo_url": None,
                    "last_seen_at": "2026-08-05T00:00:00+00:00",
                    "created_at": "2026-08-01T00:00:00+00:00",
                    "updated_at": "2026-08-05T00:00:00+00:00",
                }
            ]
        if "percentile_cont(0.5)" in query:
            # Every event in the current window is stamped with the raw
            # instrumentation label only — the registered id never
            # appears, so _PREFERRED_AGENT_ID_SQL has nothing else to
            # collapse onto within this window.
            return [
                {
                    "agent_id": SYNTHETIC_LABEL,
                    "runs": 5,
                    "cost_usd": 1.25,
                    "tokens": 500,
                    "success_rate": 1.0,
                    "p50": 100.0,
                    "p95": 200.0,
                    "last_seen": "2026-08-05T00:00:00+00:00",
                }
            ]
        if "FROM agent_identity_aliases" in query:
            return [
                {"synthetic_label": k, "agent_id": v}
                for k, v in self._persisted_aliases.items()
            ]
        if "trace_pref AS (" in query:
            return [
                {"synthetic_label": k, "agent_id": v} for k, v in self._alias_pairs
            ]
        if "FROM agent_issues" in query:
            return []
        raise AssertionError(f"unexpected query in fake client: {query[:80]}")

    async def execute(self, query: str, *args):
        self.executed.append((query, args))
        return "OK"


@pytest.mark.asyncio
async def test_persisted_alias_merges_ghost_card_into_registered_card():
    """Full-fix behavior: a persisted alias merges metrics instead of
    producing a second card, even when the current window offers no fresh
    evidence linking the two labels."""
    fake = _FakeClient(persisted_aliases={SYNTHETIC_LABEL: REGISTERED_ID})

    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=fake),
    ):
        cards = await portal_mod.list_portal_agents(
            org_id="org_1",
            window="24h",
            _user={"sub": "u1"},
        )

    ids = [c.id for c in cards]
    assert ids.count(REGISTERED_ID) == 1, "registered agent must render exactly one card"
    assert SYNTHETIC_LABEL not in ids, "raw telemetry label must not survive as its own card"

    card = next(c for c in cards if c.id == REGISTERED_ID)
    assert card.runs24h == 5, "merged card must carry the synthetic label's metrics"
    assert card.status == "live"
    assert card.mergedIdentities == [SYNTHETIC_LABEL]


@pytest.mark.asyncio
async def test_freshly_discovered_alias_pair_also_merges_same_call():
    """When the current window *does* offer evidence (the winning and
    losing agent_id co-occur on a trace), the merge applies immediately,
    without waiting on a previously-persisted row."""
    fake = _FakeClient(alias_pairs=[(SYNTHETIC_LABEL, REGISTERED_ID)])

    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=fake),
    ):
        cards = await portal_mod.list_portal_agents(
            org_id="org_1",
            window="24h",
            _user={"sub": "u1"},
        )

    ids = [c.id for c in cards]
    assert ids.count(REGISTERED_ID) == 1
    assert SYNTHETIC_LABEL not in ids

    card = next(c for c in cards if c.id == REGISTERED_ID)
    assert card.runs24h == 5
    assert card.mergedIdentities == [SYNTHETIC_LABEL]

    # Newly discovered pairs must be persisted (best-effort) so later
    # calls stay read-only for this table.
    assert any(
        "INSERT INTO agent_identity_aliases" in q for q, _args in fake.executed
    )


@pytest.mark.asyncio
async def test_no_alias_evidence_still_produces_sdk_only_card_unchanged():
    """No regression: with no alias evidence at all (old behavior target),
    an unrecognized telemetry label still surfaces as its own SDK-only
    card rather than silently vanishing."""
    fake = _FakeClient()

    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=fake),
    ):
        cards = await portal_mod.list_portal_agents(
            org_id="org_1",
            window="24h",
            _user={"sub": "u1"},
        )

    ids = [c.id for c in cards]
    assert REGISTERED_ID in ids
    assert SYNTHETIC_LABEL in ids

    registered_card = next(c for c in cards if c.id == REGISTERED_ID)
    assert registered_card.runs24h == 0
    ghost_card = next(c for c in cards if c.id == SYNTHETIC_LABEL)
    assert ghost_card.runs24h == 5
    assert ghost_card.mergedIdentities == []
