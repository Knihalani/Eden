"""``_enrich`` must survive events that carry no token counts.

``total`` was assigned only inside the ``if input_tokens is not None or
output_tokens is not None:`` branch, but read unconditionally two lines later
by ``if cost is None and total is not None:``. Two failure modes followed:

1. The first event of a batch with no token metadata raised
   ``UnboundLocalError``. ``_enrich`` runs at step 4 of ``run_batch``, outside
   the try block that guards the Silver write, so a single tokenless event
   aborted the entire ETL pass — and ``run_from_bronze`` fetches up to 10,000
   Bronze rows per call. The ``storage``, ``sandbox`` and ``api_request``
   event types never carry token counts, so this is the ordinary path.

2. Once any earlier event in the same batch had set ``total``, the name stayed
   bound for the rest of the loop. A later tokenless event then took the
   estimation branch using the *previous* event's tokens, stamping
   ``estimated_cost_usd`` on a row that has no token data at all.
"""

from __future__ import annotations

import pytest

from eden.data_platform.silver_etl import SilverETLPipeline


@pytest.fixture
def etl() -> SilverETLPipeline:
    return SilverETLPipeline()


class TestEnrichWithoutTokens:
    def test_tokenless_event_does_not_raise(self, etl: SilverETLPipeline) -> None:
        """A storage event has no token counts and must still enrich."""
        event = {
            "id": "11111111-1111-1111-1111-111111111111",
            "event_type": "storage",
            "metadata": {},
            "cost_usd": None,
        }

        enriched = etl._enrich([event])

        assert len(enriched) == 1
        assert enriched[0].get("total_tokens") is None
        # No token data means no basis for an estimate.
        assert "estimated_cost_usd" not in enriched[0]

    def test_total_does_not_leak_across_events(self, etl: SilverETLPipeline) -> None:
        """A tokenless event must not inherit the previous event's ``total``."""
        with_tokens = {
            "id": "22222222-2222-2222-2222-222222222222",
            "event_type": "llm_call",
            "metadata": {"input_tokens": 1000, "output_tokens": 500},
            "cost_usd": None,
        }
        without_tokens = {
            "id": "33333333-3333-3333-3333-333333333333",
            "event_type": "storage",
            "metadata": {},
            "cost_usd": None,
        }

        first, second = etl._enrich([with_tokens, without_tokens])

        assert first["total_tokens"] == 1500
        assert first["estimated_cost_usd"] == pytest.approx(0.0105)

        assert second.get("total_tokens") is None
        assert "estimated_cost_usd" not in second

    def test_batch_of_tokenless_events_survives(self, etl: SilverETLPipeline) -> None:
        """The whole batch enriches, not just up to the first tokenless row."""
        events = [
            {"id": f"e{i}", "event_type": "api_request", "metadata": {}, "cost_usd": None}
            for i in range(5)
        ]

        enriched = etl._enrich(events)

        assert len(enriched) == 5
        assert all("estimated_cost_usd" not in e for e in enriched)
        assert all(e.get("silver_event_id") for e in enriched)
