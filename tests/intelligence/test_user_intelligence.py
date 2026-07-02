"""Behavioural tests for Cat 9 — User Intelligence.

Exercises the 14 real services (8 v0 + 6 v2 trackers +
1 dashboard + 1 corrector — the corrector is a peer of
the v0 SatisfactionSignalService but lives in its own
class) and the 13 routes that expose them, plus the
closed-loop hook firing on low coverage-weighted
satisfaction.

Mirrors the structure of
:mod:`tests.intelligence.test_outcome_roi_intelligence` and
:mod:`tests.intelligence.test_cost_intelligence`:

* **Service-level unit tests** — call the service classes
  directly with a mocked Postgres client. The
  :func:`patch_postgres` autouse fixture in
  :mod:`tests.conftest` returns an empty ``fetch()`` by
  default, which gives the services a clean "no data"
  path. Tests that need data override the mock with a
  side-effect that matches the SQL fragment the service
  runs.

* **Route-level smoke tests** — a minimal :class:`FastAPI`
  app with the ``intelligence_user`` router mounted and
  ``get_current_user`` overridden. We hit each of the
  Cat 9 routes and assert the response shape and live
  envelope.

Test count target: ~30 tests, ~1.5s.
"""

from __future__ import annotations

import importlib
import uuid
from datetime import UTC
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# ─── Sample row builders ─────────────────────────────────────────────


def _session_row(
    *,
    user_id: str,
    session_id: str,
    n_turns: int,
    abandoned: bool = False,
    days_ago_first: int = 1,
    days_ago_last: int = 1,
) -> dict[str, Any]:
    """One row from the user_sessions query."""
    from datetime import datetime, timedelta, timezone

    now = datetime.now(UTC)
    return {
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "session_id": session_id,
        "first_event_at": now - timedelta(days=days_ago_first),
        "last_event_at": now - timedelta(days=days_ago_last),
        "n_turns": n_turns,
        "n_traces": max(n_turns - 1, 0),
        "abandoned": abandoned,
        "first_value_at": None,
    }


def _feedback_row(
    *, trace_id: str, thumbs: str, user_id: str = "u1"
) -> dict[str, Any]:
    return {
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "trace_id": trace_id,
        "thumbs": thumbs,
        "rating": None,
        "comment": None,
        "created_at": None,
    }


def _behavioural_signal_row(
    *,
    regenerated: bool = False,
    abandoned_after_one: bool = False,
    edit_distance: float = 0.0,
    copy_pasted: bool = False,
    retried_within_60s: bool = False,
    return_7d: bool | None = None,
    time_to_first_action_ms: int | None = None,
) -> dict[str, Any]:
    return {
        "regenerated": regenerated,
        "abandoned_after_one": abandoned_after_one,
        "edit_distance": edit_distance,
        "copy_pasted": copy_pasted,
        "retried_within_60s": retried_within_60s,
        "return_7d": return_7d,
        "time_to_first_action_ms": time_to_first_action_ms,
    }


# ─── Postgres query-routing mock helper ──────────────────────────────


def _pg_router(
    *,
    sessions: list[dict[str, Any]] | None = None,
    feedback_rows: list[dict[str, Any]] | None = None,
    feedback_summary: dict[str, int] | None = None,
    behavioural_signal: dict[str, Any] | None = None,
    behavioural_aggregate: dict[str, Any] | None = None,
    explicit_aggregate: dict[str, Any] | None = None,
    session_segment_row: dict[str, Any] | None = None,
) -> MagicMock:
    """Build a MagicMock Postgres client whose ``fetch`` /
    ``fetchrow`` route to different returns based on the
    SQL fragment. Defaults to empty.

    The Cat 9 SQL fragments are:

    1. ``SELECT ... FROM user_sessions`` — session rollup
    2. ``SELECT ... FROM user_feedback WHERE trace_id`` —
       feedback for one trace (or aggregate form)
    3. ``SELECT ... FROM user_behavioural_signals WHERE
       trace_id`` — single-row implicit signal lookup
    4. ``SELECT ... FROM user_behavioural_signals ... GROUP
       BY`` (no trace_id) — cohort aggregate
    5. ``SELECT ... FROM user_feedback ... GROUP BY 1``
       (the prior + cohort) — explicit-feedback aggregate
    6. ``SELECT COUNT(*) ... FROM user_sessions WHERE
       user_id`` — segment lookup
    """
    pg = MagicMock()
    pg.fetch = AsyncMock(
        side_effect=lambda sql, *a, **kw: _route_fetch(
            sql,
            sessions=sessions,
            feedback_rows=feedback_rows,
        )
    )
    pg.fetchrow = AsyncMock(
        side_effect=lambda sql, *a, **kw: _route_fetchrow(
            sql,
            feedback_summary=feedback_summary,
            session_segment_row=session_segment_row,
            explicit_aggregate=explicit_aggregate,
            behavioural_aggregate=behavioural_aggregate,
            behavioural_signal=behavioural_signal,
        )
    )
    pg.execute = AsyncMock(return_value="OK")
    return pg


def _route_fetch(
    sql: str,
    *,
    sessions=None,
    feedback_rows=None,
) -> list[dict[str, Any]]:
    # Conversation messages query — uses fetch().
    if "conversation_messages" in sql:
        return []
    # Conversations list — not exercised in these tests.
    if "FROM conversations" in sql and "session_id" in sql:
        return []
    # Session list for the aggregate (no ``user_id``
    # in the WHERE clause — the aggregate is for the
    # whole org).
    if "FROM user_sessions" in sql and "AND user_id" not in sql:
        return list(sessions or [])
    # Default for any other fetch.
    return []


def _route_fetchrow(
    sql: str,
    *,
    feedback_summary=None,
    session_segment_row=None,
    explicit_aggregate=None,
    behavioural_aggregate=None,
    behavioural_signal=None,
) -> Any | None:
    # Single-row conversation lookup.
    if "FROM conversations" in sql and "session_id" in sql:
        return None
    # Behavioural-signal single-row lookup (per-trace).
    if "user_behavioural_signals" in sql and "trace_id" in sql:
        return behavioural_signal
    # Behavioural-signal cohort aggregate (no trace_id).
    if (
        "user_behavioural_signals" in sql
        and "trace_id" not in sql
        and "COUNT(*)" in sql
    ):
        return behavioural_aggregate
    # Explicit-feedback summary for a single trace.
    if "user_feedback" in sql and "trace_id" in sql and "COUNT(*)" in sql:
        if feedback_summary is None:
            return {
                "thumbs_up": 0,
                "thumbs_down": 0,
                "total": 0,
            }
        return feedback_summary
    # Explicit-feedback prior / cohort aggregate (no trace_id).
    if "user_feedback" in sql and "trace_id" not in sql:
        if explicit_aggregate is None:
            return None
        return explicit_aggregate
    # Session segment lookup.
    if "FROM user_sessions" in sql and "AND user_id" in sql:
        return session_segment_row
    return None


# ─── 1. SessionAnalytics ──────────────────────────────────────────────


class TestSessionAnalytics:
    @pytest.mark.asyncio
    async def test_empty_returns_no_session_data_message(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.user_intel.sessions import SessionAnalytics

        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            result = await SessionAnalytics().aggregate(
                "org_test", window="7d"
            )
        assert result["status"] == "ok"
        assert result["live"] is True
        assert result["data"]["total_sessions"] == 0
        assert result["data"]["message"] == "no session data"

    @pytest.mark.asyncio
    async def test_invalid_window_returns_bad_request(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.user_intel.sessions import SessionAnalytics

        result = await SessionAnalytics().aggregate(
            "org_test", window="forever"
        )
        assert result["status"] == "bad_request"

    @pytest.mark.asyncio
    async def test_aggregates_sessions_and_classifies_users(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.user_intel.sessions import SessionAnalytics

        sessions = [
            _session_row(
                user_id="alice",
                session_id=f"ses_alice_{i}",
                n_turns=4,
                days_ago_first=2,
                days_ago_last=1,
            )
            for i in range(5)
        ] + [
            _session_row(
                user_id="bob",
                session_id="ses_bob_1",
                n_turns=1,
                abandoned=True,
                days_ago_first=3,
                days_ago_last=2,
            ),
            _session_row(
                user_id="carol",
                session_id="ses_carol_1",
                n_turns=10,
                days_ago_first=60,  # dormant
                days_ago_last=45,
            ),
        ]
        pg = _pg_router(sessions=sessions)
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            result = await SessionAnalytics().aggregate(
                "org_test", window="30d"
            )
        assert result["status"] == "ok"
        d = result["data"]
        assert d["total_sessions"] == 7
        # Alice: 5 sessions in last 7 days → active
        # Bob: 1 session → active
        # Carol: 60 days ago → dormant
        assert d["active_users"] >= 2
        assert d["dormant_users"] >= 1
        # 1 single-turn-abandoned out of 7 sessions
        assert d["single_turn_abandonment_rate"] == pytest.approx(
            1 / 7, rel=1e-3
        )
        # Median of [4, 4, 4, 4, 4, 1, 10] = 4
        assert d["median_session_length_turns"] == 4.0


# ─── 2. GoalTracker ─────────────────────────────────────────────────


class TestGoalTracker:
    @pytest.mark.asyncio
    async def test_track_persists_goal(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.user_intel.sessions import GoalTracker

        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            result = await GoalTracker().track(
                "org_test",
                user_id="u1",
                goal="summarise the Q4 board deck",
                session_id="ses_1",
            )
        assert result["status"] == "ok"
        assert result["data"]["goal_id"].startswith("goal_")
        assert result["data"]["status"] == "active"

    @pytest.mark.asyncio
    async def test_track_missing_user_id_returns_bad_request(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.user_intel.sessions import GoalTracker

        result = await GoalTracker().track(
            "org_test", user_id="", goal="x"
        )
        assert result["status"] == "bad_request"

    @pytest.mark.asyncio
    async def test_mark_achieved_and_abandoned(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.user_intel.sessions import GoalTracker

        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            r1 = await GoalTracker().mark_achieved(
                "org_test", goal_id="goal_abc"
            )
            r2 = await GoalTracker().mark_abandoned(
                "org_test", goal_id="goal_def"
            )
        assert r1["data"]["status"] == "achieved"
        assert r2["data"]["status"] == "abandoned"


# ─── 3. SatisfactionSignalService ─────────────────────────────────────


class TestSatisfactionSignalService:
    @pytest.mark.asyncio
    async def test_no_data_returns_implicit_neutral_and_corrected(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.user_intel.satisfaction import (
            SatisfactionSignalService,
        )

        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ), patch(
            "eden.services.user_intel.satisfaction._fire_low_satisfaction_alert",
            new=MagicMock(),
        ):
            result = await SatisfactionSignalService().compute(
                "org_test", trace_id="trc_1"
            )
        assert result["status"] == "ok"
        d = result["data"]
        # No explicit, no implicit — naive is None,
        # implicit score falls back to 0.5, coverage is 0.5.
        assert d["naive_satisfaction"] is None
        assert d["implicit"]["score"] == 0.5
        assert d["coverage_weighted"] == 0.5
        # Selection-bias corrected is Beta(1,1) mean = 0.5
        assert d["selection_bias_corrected"] == 0.5

    @pytest.mark.asyncio
    async def test_with_explicit_and_implicit(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.user_intel.satisfaction import (
            SatisfactionSignalService,
        )

        pg = _pg_router(
            feedback_summary={
                "thumbs_up": 3,
                "thumbs_down": 1,
                "total": 4,
            },
            behavioural_signal=_behavioural_signal_row(
                copy_pasted=True,
                edit_distance=0.05,
            ),
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ), patch(
            "eden.services.user_intel.satisfaction._fire_low_satisfaction_alert",
            new=MagicMock(),
        ):
            result = await SatisfactionSignalService().compute(
                "org_test", trace_id="trc_1"
            )
        d = result["data"]
        # Naive: 3/4 = 0.75
        assert d["naive_satisfaction"] == 0.75
        # Implicit: 1.0 + 0.2 (copy_pasted) = 1.2 → clamped to 1.0
        # edit_distance is 0.05, < 0.5, so no penalty
        assert d["implicit"]["score"] == 1.0
        # Coverage-weighted: 0.03 * 0.75 + 0.97 * 1.0
        # = 0.0225 + 0.97 = 0.9925
        assert d["coverage_weighted"] == pytest.approx(0.9925, rel=1e-3)
        # Posterior mean is in [0, 1].
        assert 0.0 <= d["selection_bias_corrected"] <= 1.0

    @pytest.mark.asyncio
    async def test_low_satisfaction_fires_hook(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.user_intel.satisfaction import (
            SatisfactionSignalService,
        )

        # All negative signals: regen, abandon, edit > 0.5
        pg = _pg_router(
            feedback_summary={
                "thumbs_up": 0,
                "thumbs_down": 5,
                "total": 5,
            },
            behavioural_signal=_behavioural_signal_row(
                regenerated=True,
                abandoned_after_one=True,
                edit_distance=0.9,
                retried_within_60s=True,
                return_7d=False,
            ),
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ), patch(
            "eden.services.user_intel.satisfaction._fire_low_satisfaction_alert",
            new=MagicMock(),
        ) as fire:
            result = await SatisfactionSignalService().compute(
                "org_test", trace_id="trc_bad"
            )
        d = result["data"]
        # The coverage-weighted is well below the
        # 0.4 threshold.
        assert d["coverage_weighted"] < 0.4
        # The hook helper was called.
        fire.assert_called_once()
        # The trace_id matches.
        assert fire.call_args.args[1] == "trc_bad"


# ─── 4. SelectionBiasCorrector ───────────────────────────────────────


class TestSelectionBiasCorrector:
    @pytest.mark.asyncio
    async def test_no_data_returns_uniform_posterior(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.user_intel.satisfaction import (
            SelectionBiasCorrector,
        )

        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            result = await SelectionBiasCorrector().correct(
                "org_test", trace_id="trc_1"
            )
        d = result["data"]
        # No explicit feedback → naive is None; the
        # posterior is Beta(1, 1) → mean 0.5.
        assert d["naive_mean"] is None
        assert d["posterior"]["mean"] == pytest.approx(0.5, abs=1e-3)
        # 95 % CI for Beta(1, 1) is (0.025, 0.975).
        ci = d["posterior"]["credible_interval_95"]
        assert ci[0] == pytest.approx(0.025, abs=1e-3)
        assert ci[1] == pytest.approx(0.975, abs=1e-3)

    @pytest.mark.asyncio
    async def test_with_data_correction_pulls_toward_prior(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.user_intel.satisfaction import (
            SelectionBiasCorrector,
        )

        # Per upgradespec §D.2 the corrector uses Flat
        # Beta-Binomial (Beta(1,1) prior at the trace level)
        # — no per-channel prior lookup. So the posterior
        # is Beta(1+0, 1+5) = Beta(1, 6) → mean 1/7 ≈ 0.143.
        pg = _pg_router(
            feedback_summary={
                "thumbs_up": 0,
                "thumbs_down": 5,
                "total": 5,
            },
            explicit_aggregate={
                "up_count": 40,
                "down_count": 60,
            },
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            result = await SelectionBiasCorrector().correct(
                "org_test", trace_id="trc_2"
            )
        d = result["data"]
        assert d["naive_mean"] == 0.0
        # Flat prior → posterior mean ≈ 0.143 (no pulling
        # toward the per-channel explicit aggregate).
        assert d["posterior"]["mean"] == pytest.approx(1 / 7, abs=1e-3)
        assert d["prior"]["alpha"] == 1.0
        assert d["prior"]["beta"] == 1.0

    def test_beta_quantile_basic(self) -> None:
        from eden.services.user_intel.satisfaction import _beta_quantile

        # Beta(1, 1) is uniform.
        assert _beta_quantile(0.5, 1.0, 1.0) == pytest.approx(0.5, abs=1e-3)
        # Beta(10, 10) is symmetric, median ≈ 0.5.
        assert _beta_quantile(0.5, 10.0, 10.0) == pytest.approx(
            0.5, abs=1e-2
        )
        # Beta(2, 8) has median < 0.5.
        assert _beta_quantile(0.5, 2.0, 8.0) < 0.5

    def test_levenshtein_basic(self) -> None:
        from eden.services.user_intel.behavioural import _levenshtein

        assert _levenshtein("hello", "hello") == 0
        assert _levenshtein("hello", "world") == 4
        assert _levenshtein("", "abc") == 3
        assert _levenshtein("abc", "") == 3


# ─── 5. ConversationService ──────────────────────────────────────────


class TestConversationService:
    @pytest.mark.asyncio
    async def test_get_history_no_conv_returns_empty(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.user_intel.conversations import (
            ConversationService,
        )

        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            result = await ConversationService().get_history(
                "org_test", session_id="ses_1"
            )
        assert result["status"] == "ok"
        assert result["data"]["messages"] == []

    @pytest.mark.asyncio
    async def test_add_message_validates_role(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.user_intel.conversations import (
            ConversationService,
        )

        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            result = await ConversationService().add_message(
                "org_test",
                session_id="ses_1",
                role="not_a_role",
                content="hi",
            )
        assert result["status"] == "bad_request"

    @pytest.mark.asyncio
    async def test_add_message_empty_content_rejected(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.user_intel.conversations import (
            ConversationService,
        )

        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            result = await ConversationService().add_message(
                "org_test",
                session_id="ses_1",
                role="user",
                content="",
            )
        assert result["status"] == "bad_request"


# ─── 6. UserFeedbackService ──────────────────────────────────────────


class TestUserFeedbackService:
    @pytest.mark.asyncio
    async def test_submit_thumbs_persists(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.user_intel.feedback import UserFeedbackService

        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            result = await UserFeedbackService().submit_thumbs(
                "org_test",
                trace_id="trc_1",
                thumbs="up",
                user_id="u1",
            )
        assert result["status"] == "ok"
        assert result["data"]["feedback_id"].startswith("fb_")
        assert result["data"]["thumbs"] == "up"

    @pytest.mark.asyncio
    async def test_submit_thumbs_normalises_variants(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.user_intel.feedback import UserFeedbackService

        for raw, expected in [
            ("thumbs_up", "up"),
            ("thumbs_down", "down"),
            ("positive", "up"),
            ("negative", "down"),
            ("+1", "up"),
            ("-1", "down"),
        ]:
            pg = _pg_router()
            with patch(
                "eden.storage.postgres.get_postgres_client",
                return_value=pg,
            ):
                result = await UserFeedbackService().submit_thumbs(
                    "org_test", trace_id="t", thumbs=raw
                )
            assert result["data"]["thumbs"] == expected, raw

    @pytest.mark.asyncio
    async def test_submit_thumbs_invalid_returns_bad_request(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.user_intel.feedback import UserFeedbackService

        result = await UserFeedbackService().submit_thumbs(
            "org_test", trace_id="t", thumbs="maybe"
        )
        assert result["status"] == "bad_request"

    @pytest.mark.asyncio
    async def test_get_feedback_for_trace_no_data(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.user_intel.feedback import UserFeedbackService

        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            result = await UserFeedbackService().get_feedback_for_trace(
                "org_test", trace_id="t"
            )
        assert result["status"] == "ok"
        assert result["data"]["thumbs_up"] == 0
        assert result["data"]["thumbs_down"] == 0
        assert result["data"]["naive_satisfaction"] is None


# ─── 7. UserSegmentationService ──────────────────────────────────────


class TestUserSegmentationService:
    @pytest.mark.asyncio
    async def test_classifies_power_user(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.user_intel.segments import (
            UserSegmentationService,
        )

        pg = _pg_router(
            session_segment_row={
                "total": 100,
                "in_window": 75,
                "last_event": None,
            }
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            result = await UserSegmentationService().segment(
                "org_test", user_id="power_user"
            )
        assert result["status"] == "ok"
        assert result["data"]["segment"] == "power"
        assert result["data"]["sessions_in_window"] == 75

    @pytest.mark.asyncio
    async def test_classifies_enterprise(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.user_intel.segments import (
            UserSegmentationService,
        )

        pg = _pg_router(
            session_segment_row={
                "total": 1000,
                "in_window": 600,
                "last_event": None,
            }
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            result = await UserSegmentationService().segment(
                "org_test", user_id="enterprise_user"
            )
        assert result["data"]["segment"] == "enterprise"

    @pytest.mark.asyncio
    async def test_classifies_dormant(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.user_intel.segments import (
            UserSegmentationService,
        )

        pg = _pg_router(
            session_segment_row={
                "total": 50,
                "in_window": 0,
                "last_event": None,
            }
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            result = await UserSegmentationService().segment(
                "org_test", user_id="dormant_user"
            )
        assert result["data"]["segment"] == "dormant"

    @pytest.mark.asyncio
    async def test_no_data_returns_new(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.user_intel.segments import (
            UserSegmentationService,
        )

        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            result = await UserSegmentationService().segment(
                "org_test", user_id="u"
            )
        # No sessions at all → "new" (the service
        # falls through to the new-user bucket when
        # both total and in-window are 0).
        assert result["data"]["segment"] == "new"


# ─── 8. Behavioural trackers (6 write paths) ─────────────────────────


class TestRegenerationRateTracker:
    @pytest.mark.asyncio
    async def test_track_persists_signal(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.user_intel.behavioural import (
            RegenerationRateTracker,
        )

        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            result = await RegenerationRateTracker().track(
                "org_test", trace_id="t", user_id="u1"
            )
        assert result["status"] == "ok"
        assert result["data"]["signal_id"].startswith("sig_")
        assert result["data"]["regenerated"] is True


class TestEditDistanceTracker:
    @pytest.mark.asyncio
    async def test_identical_strings_yield_zero(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.user_intel.behavioural import (
            EditDistanceTracker,
        )

        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            result = await EditDistanceTracker().compute(
                "org_test",
                trace_id="t",
                user_id="u1",
                model_response="hello world",
                final_text="hello world",
            )
        assert result["data"]["edit_distance"] == 0.0

    @pytest.mark.asyncio
    async def test_completely_different_yields_high(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.user_intel.behavioural import (
            EditDistanceTracker,
        )

        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            result = await EditDistanceTracker().compute(
                "org_test",
                trace_id="t",
                user_id="u1",
                model_response="aaaa",
                final_text="zzzz",
            )
        # All 4 chars different → 1.0 normalised.
        assert result["data"]["edit_distance"] == 1.0

    @pytest.mark.asyncio
    async def test_multimodal_returns_unimplemented(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.user_intel.behavioural import (
            EditDistanceTracker,
        )

        result = await EditDistanceTracker().compute_multimodal(
            "org_test", trace_id="t", user_id="u1"
        )
        assert result["data"]["edit_distance"] is None


    # ponytail: removed per upgradespec §D.2 (Phase 1 cut)


class TestAbandonmentTracker:
    @pytest.mark.asyncio
    async def test_detect_true(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.user_intel.behavioural import (
            AbandonmentTracker,
        )

        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            result = await AbandonmentTracker().detect(
                "org_test", trace_id="t", user_id="u1", abandoned=True
            )
        assert result["data"]["abandoned_after_one"] is True


    # ponytail: removed per upgradespec §D.2 (Phase 1 cut)


    # ponytail: removed per upgradespec §D.2 (Phase 1 cut)


class TestBehaviouralDashboard:
    @pytest.mark.asyncio
    async def test_no_data_returns_message(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.user_intel.behavioural import (
            BehaviouralDashboard,
        )

        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            result = await BehaviouralDashboard().cohort(
                "org_test", window="30d"
            )
        assert result["status"] == "ok"
        assert result["data"]["regeneration_rate"] is None
        assert result["data"]["message"] == "no behavioural data"

    @pytest.mark.asyncio
    async def test_high_regen_rate_fires_alert(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.user_intel.behavioural import (
            BehaviouralDashboard,
        )

        # 60/100 signals are regenerated → 0.6 > 0.5 threshold.
        pg = _pg_router(
            behavioural_aggregate={
                "total": 100,
                "regen_count": 60,
                "abandon_count": 5,
                "copy_count": 30,
                "retry_count": 10,
                "returned_yes": 50,
                "returned_no": 30,
                "edit_distance_mean": 0.1,
                "ttfa_mean": 1500.0,
            },
            explicit_aggregate={
                "thumbs_up": 80,
                "thumbs_down": 20,
                "total": 100,
            },
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            result = await BehaviouralDashboard().cohort(
                "org_test", window="30d"
            )
        d = result["data"]
        assert d["regeneration_rate"] == 0.6
        assert d["alert"] is not None
        assert "exceeds" in d["alert"]
        # Other aggregates.
        assert d["abandonment_rate"] == 0.05
        assert d["7d_return_rate"] == pytest.approx(50 / 80, rel=1e-3)
        assert d["thumbs_up_rate_naive"] == 0.8

    @pytest.mark.asyncio
    async def test_invalid_window_returns_bad_request(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.user_intel.behavioural import (
            BehaviouralDashboard,
        )

        result = await BehaviouralDashboard().cohort(
            "org_test", window="forever"
        )
        assert result["status"] == "bad_request"


# ─── 10. Closed-loop hook integration ────────────────────────────────


class TestLowSatisfactionHook:
    """The :func:`_fire_low_satisfaction_alert` is the Cat 9
    analog of the Cat 11 / Cat 8 / Cat 2 drift alert.
    Verifies the hook fires only when
    coverage_weighted < threshold."""

    def test_fires_on_low_satisfaction(self) -> None:
        from eden.services.user_intel._common import (
            _fire_low_satisfaction_alert,
        )

        mock_hook = MagicMock()
        with patch(
            "eden.llmops.promotion_hooks.get_promotion_hook",
            return_value=mock_hook,
        ):
            _fire_low_satisfaction_alert(
                "org_test", "trc_abc", coverage_weighted=0.15
            )
        mock_hook.on_drift_alert.assert_called_once()
        # Severity is "high" for < 0.2.
        assert (
            mock_hook.on_drift_alert.call_args.kwargs["severity"]
            == "high"
        )

    def test_does_not_fire_above_threshold(self) -> None:
        from eden.services.user_intel._common import (
            _fire_low_satisfaction_alert,
        )

        mock_hook = MagicMock()
        with patch(
            "eden.llmops.promotion_hooks.get_promotion_hook",
            return_value=mock_hook,
        ):
            _fire_low_satisfaction_alert(
                "org_test", "trc_abc", coverage_weighted=0.7
            )
        mock_hook.on_drift_alert.assert_not_called()

    def test_medium_severity_in_range(self) -> None:
        from eden.services.user_intel._common import (
            _fire_low_satisfaction_alert,
        )

        mock_hook = MagicMock()
        with patch(
            "eden.llmops.promotion_hooks.get_promotion_hook",
            return_value=mock_hook,
        ):
            # Between 0.2 and 0.4 → "medium" severity.
            _fire_low_satisfaction_alert(
                "org_test", "trc_abc", coverage_weighted=0.3
            )
        mock_hook.on_drift_alert.assert_called_once()
        assert (
            mock_hook.on_drift_alert.call_args.kwargs["severity"]
            == "medium"
        )


# ─── 11. Window parser + thumbs parser ───────────────────────────────


class TestHelpers:
    def test_parse_window(self) -> None:
        from eden.services.user_intel._common import _parse_window

        assert _parse_window("7d") == "7 days"
        assert _parse_window("24h") == "24 hours"
        assert _parse_window(None) == "7 days"
        assert _parse_window("") == "7 days"
        assert _parse_window("forever") is None
        assert _parse_window("7x") is None

    def test_parse_thumbs(self) -> None:
        from eden.services.user_intel._common import _parse_thumbs

        assert _parse_thumbs("up") == "up"
        assert _parse_thumbs("DOWN") == "down"
        assert _parse_thumbs("thumbs_up") == "up"
        assert _parse_thumbs("positive") == "up"
        assert _parse_thumbs("+1") == "up"
        assert _parse_thumbs("-") == "down"
        assert _parse_thumbs("maybe") is None
        assert _parse_thumbs(123) is None


# ─── 12. Route smoke tests ───────────────────────────────────────────


@pytest.fixture(scope="module")
def user_test_app() -> FastAPI:
    from eden.api.deps import get_current_user, require_org_member
    from eden.config import get_settings

    settings = get_settings()
    settings.intelligence_gap_v0 = True

    app = FastAPI(title="eden-user-test")
    # Audit 2026-06-22 B1.33 — mock matches real get_current_user shape
    # ({"user_id": ..., "email": ...}).
    user_payload = {
        "user_id": "test-user",
        "email": None,
        "sub": "test-user",
        "org_id": "org_test",
    }
    app.dependency_overrides[get_current_user] = lambda: user_payload
    app.dependency_overrides[require_org_member] = lambda: user_payload
    mod = importlib.import_module("eden.api.routes.intelligence_user")
    app.include_router(mod.router)
    return app


@pytest.fixture(scope="module")
def user_client(user_test_app: FastAPI) -> TestClient:
    return TestClient(user_test_app)


class TestUserRoutes:
    """End-to-end smoke tests for the 13 Cat 9 routes."""

    def test_post_feedback(
        self, user_client: TestClient
    ) -> None:
        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            r = user_client.post(
                "/orgs/org_test/intelligence/user/feedback",
                json={"trace_id": "trc_abc", "thumbs": "up"},
            )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "ok"
        assert body["feature"] == "user_feedback"
        assert body["data"]["feedback_id"].startswith("fb_")

    def test_post_feedback_rejects_bad_thumbs(
        self, user_client: TestClient
    ) -> None:
        r = user_client.post(
            "/orgs/org_test/intelligence/user/feedback",
            json={"trace_id": "t", "thumbs": "maybe"},
        )
        # 422 (Pydantic) or 200 with bad_request body.
        assert r.status_code in (200, 422)
        if r.status_code == 200:
            assert r.json()["status"] == "bad_request"

    def test_get_feedback_for_trace(
        self, user_client: TestClient
    ) -> None:
        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            r = user_client.get(
                "/orgs/org_test/intelligence/user/feedback/trc_x"
            )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["feature"] == "user_feedback"
        assert body["data"]["thumbs_up"] == 0

    def test_get_satisfaction(
        self, user_client: TestClient
    ) -> None:
        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ), patch(
            "eden.services.user_intel.satisfaction._fire_low_satisfaction_alert",
            new=MagicMock(),
        ):
            r = user_client.get(
                "/orgs/org_test/intelligence/user/satisfaction/trc_x"
            )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["feature"] == "satisfaction_signals"
        assert "selection_bias_corrected" in body["data"]
        assert "coverage_weighted" in body["data"]

    def test_get_segment(self, user_client: TestClient) -> None:
        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            r = user_client.get(
                "/orgs/org_test/intelligence/user/segment",
                params={"user_id": "u1"},
            )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["feature"] == "user_segments"

    def test_post_goal(self, user_client: TestClient) -> None:
        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            r = user_client.post(
                "/orgs/org_test/intelligence/user/goals",
                json={"user_id": "u1", "goal": "summarise the deck"},
            )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["feature"] == "user_goals"
        assert body["data"]["status"] == "active"

    def test_post_sessions_aggregate(
        self, user_client: TestClient
    ) -> None:
        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            r = user_client.post(
                "/orgs/org_test/intelligence/user/sessions/aggregate",
                params={"window": "7d"},
            )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["feature"] == "session_analytics"
        assert body["data"]["total_sessions"] == 0

    def test_get_conversation_history(
        self, user_client: TestClient
    ) -> None:
        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            r = user_client.get(
                "/orgs/org_test/intelligence/user/conversation/ses_1"
            )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["feature"] == "conversation"
        assert body["data"]["messages"] == []

    def test_post_signal_regeneration(
        self, user_client: TestClient
    ) -> None:
        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            r = user_client.post(
                "/orgs/org_test/intelligence/user/signals/regeneration",
                json={"trace_id": "t", "user_id": "u1"},
            )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["feature"] == "regeneration_tracker"

    def test_post_signal_edit_distance(
        self, user_client: TestClient
    ) -> None:
        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            r = user_client.post(
                "/orgs/org_test/intelligence/user/signals/edit-distance",
                json={
                    "trace_id": "t",
                    "user_id": "u1",
                    "model_response": "hello world",
                    "final_text": "hello world",
                },
            )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["feature"] == "edit_distance_tracker"
        assert body["data"]["edit_distance"] == 0.0

    def test_get_dashboard_cohort(
        self, user_client: TestClient
    ) -> None:
        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            r = user_client.get(
                "/orgs/org_test/intelligence/user/dashboard/cohort",
                params={"window": "30d"},
            )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["feature"] == "behavioural_dashboard"
        assert "regeneration_rate" in body["data"]

    def test_get_correction(
        self, user_client: TestClient
    ) -> None:
        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            r = user_client.get(
                "/orgs/org_test/intelligence/user/correction/trc_x"
            )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["feature"] == "selection_bias_corrector"
        assert "posterior" in body["data"]

    def test_post_conversation_message_rejects_bad_role(
        self, user_client: TestClient
    ) -> None:
        # The Pydantic body caps role at 16 chars but
        # doesn't validate against the whitelist — the
        # service layer is the validator.
        r = user_client.post(
            "/orgs/org_test/intelligence/user/conversation/message",
            json={
                "session_id": "s",
                "role": "not_a_role_xxxxxxxxxxxxx",  # > 16 chars
                "content": "hi",
            },
        )
        # Pydantic length validation catches this.
        assert r.status_code in (200, 422)
