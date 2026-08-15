"""Unit tests for the app/site-layer integration services + routes (Phase A1).

Covers:
- AppEventsService.ingest_batch (validation + per-row insert)
- SessionIdentityService.start / end / identify / get
- PresignedFeedbackService.issue + consume

Pydantic validation tests for the request bodies.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from pydantic import ValidationError

from eden.services.app_intel.events import MAX_BATCH, AppEventsService
from eden.services.app_intel.presigned import DEFAULT_TTL_SECONDS, PresignedFeedbackService
from eden.services.app_intel.sessions import DEFAULT_TTL_HOURS, SessionIdentityService

# ── AppEventsService ──────────────────────────────────────────────────


class TestAppEventsValidation:
    def test_max_batch_constant(self):
        assert MAX_BATCH == 1000

    def test_valid_event_dict_passes(self):
        from eden.services.app_intel.events import _validate

        event = {
            "name": "button_click",
            "ts": "2026-06-19T12:00:00Z",
            "source": "browser",
        }
        assert _validate(event) is None

    def test_missing_name_rejected(self):
        from eden.services.app_intel.events import _validate

        event = {"ts": "2026-06-19T12:00:00Z"}
        assert _validate(event) is not None
        assert "name" in _validate(event)

    def test_unknown_source_rejected(self):
        from eden.services.app_intel.events import _validate

        event = {
            "name": "click",
            "ts": "2026-06-19T12:00:00Z",
            "source": "watch",
        }
        assert _validate(event) is not None

    def test_source_defaults_to_browser(self):
        from eden.services.app_intel.events import _validate

        event = {"name": "click", "ts": "2026-06-19T12:00:00Z"}
        assert _validate(event) is None


class StrictAppEventsClient:
    """A fake Postgres client that enforces the real column types.

    ``app_events`` is ``id UUID NOT NULL`` and ``ts TIMESTAMPTZ NOT
    NULL`` (migration 036), and asyncpg refuses a str for either.

    The tests below used to drive a bare ``MagicMock``, which happily
    accepted ``"app_<32 hex>"`` for a UUID column and an ISO *string*
    for a timestamptz. So the suite was green while every single
    insert raised in production and the table sat at zero rows for its
    entire life. A fake that does not model the constraints the real
    system enforces cannot catch the bugs that matter — hence this.
    """

    #: Bind types for the 9 params of the INSERT, in order.
    COLUMN_TYPES: tuple[Any, ...] = (
        uuid.UUID,                # id       UUID NOT NULL
        str,                      # org_id   VARCHAR NOT NULL
        (str, type(None)),        # session_id
        (str, type(None)),        # user_id
        (str, type(None)),        # trace_id
        str,                      # name     NOT NULL
        str,                      # source   NOT NULL
        datetime,                 # ts       TIMESTAMPTZ NOT NULL
        (str, type(None)),        # properties (JSONB, bound as text)
    )

    def __init__(self) -> None:
        self.rows: list[tuple[Any, ...]] = []
        self.execute_calls = 0
        self.executemany_calls = 0

    def _check(self, args: tuple[Any, ...]) -> None:
        if len(args) != len(self.COLUMN_TYPES):
            raise TypeError(
                f"expected {len(self.COLUMN_TYPES)} binds, got {len(args)}"
            )
        for idx, (value, expected) in enumerate(
            zip(args, self.COLUMN_TYPES, strict=True), start=1
        ):
            if not isinstance(value, expected):
                raise TypeError(
                    f"invalid input for query argument ${idx}: "
                    f"{value!r} (expected {expected}, got {type(value)})"
                )
        if args[7].tzinfo is None:
            raise TypeError("TIMESTAMPTZ requires a tz-aware datetime")

    async def execute(self, _query: str, *args: Any) -> str:
        self.execute_calls += 1
        self._check(args)
        self.rows.append(args)
        return "INSERT 0 1"

    async def executemany(self, _query: str, rows: Any) -> str:
        self.executemany_calls += 1
        materialised = [tuple(r) for r in rows]
        for row in materialised:
            self._check(row)
        self.rows.extend(materialised)
        return f"INSERT 0 {len(materialised)}"


def _patch_client(m: pytest.MonkeyPatch, client: Any) -> None:
    from eden.services.app_intel import events as events_mod

    async def fake_get_client():
        return client

    m.setattr(events_mod, "_get_client", fake_get_client)


class TestAppEventsService:
    @pytest.mark.asyncio
    async def test_no_postgres_raises_instead_of_reporting_success(self):
        """A missing DB is a server fault, not a batch of bad rows.

        This previously returned {"accepted": 0, "rejected": N} and the
        route turned that into HTTP 200, so SDKs treated a total loss
        as a successful flush and never retried.
        """
        from eden.services.app_intel.events import AppEventsUnavailableError

        svc = AppEventsService()
        with pytest.MonkeyPatch.context() as m:
            _patch_client(m, None)
            with pytest.raises(AppEventsUnavailableError):
                await svc.ingest_batch(
                    "org_1", [{"name": "x", "ts": "2026-06-19T12:00:00Z"}]
                )

    @pytest.mark.asyncio
    async def test_valid_events_bind_types_postgres_accepts(self):
        svc = AppEventsService()
        client = StrictAppEventsClient()
        events = [
            {"name": "click", "ts": "2026-06-19T12:00:00Z", "source": "browser"},
            {"name": "page", "ts": "2026-06-19T12:00:01Z", "source": "browser"},
        ]
        with pytest.MonkeyPatch.context() as m:
            _patch_client(m, client)
            result = await svc.ingest_batch("org_1", events)

        assert result == {"accepted": 2, "rejected": 0, "total": 2}
        assert len(client.rows) == 2
        # id must be a real UUID, not a prefixed string
        assert all(isinstance(row[0], uuid.UUID) for row in client.rows)
        # ts must be a tz-aware datetime, not an ISO string
        assert all(isinstance(row[7], datetime) for row in client.rows)
        assert all(row[7].tzinfo is not None for row in client.rows)

    @pytest.mark.asyncio
    async def test_batch_uses_one_round_trip_not_one_per_event(self):
        """50 events per browser flush must not be 50 Neon round-trips."""
        svc = AppEventsService()
        client = StrictAppEventsClient()
        events = [
            {"name": f"e{i}", "ts": "2026-06-19T12:00:00Z"} for i in range(50)
        ]
        with pytest.MonkeyPatch.context() as m:
            _patch_client(m, client)
            result = await svc.ingest_batch("org_1", events)

        assert result["accepted"] == 50
        assert client.executemany_calls == 1
        assert client.execute_calls == 0

    @pytest.mark.asyncio
    async def test_ingest_batch_skips_invalid_events(self):
        svc = AppEventsService()
        client = StrictAppEventsClient()
        events = [
            {"name": "good", "ts": "2026-06-19T12:00:00Z"},
            {"ts": "2026-06-19T12:00:01Z"},  # missing name
        ]
        with pytest.MonkeyPatch.context() as m:
            _patch_client(m, client)
            result = await svc.ingest_batch("org_1", events)
        assert result["accepted"] == 1
        assert result["rejected"] == 1
        assert len(client.rows) == 1

    @pytest.mark.asyncio
    async def test_unparseable_timestamp_is_rejected_not_raised(self):
        """A bad ts is the client's fault — reject the row, keep the rest."""
        svc = AppEventsService()
        client = StrictAppEventsClient()
        events = [
            {"name": "good", "ts": "2026-06-19T12:00:00Z"},
            {"name": "bad", "ts": "not-a-timestamp"},
        ]
        with pytest.MonkeyPatch.context() as m:
            _patch_client(m, client)
            result = await svc.ingest_batch("org_1", events)
        assert result == {"accepted": 1, "rejected": 1, "total": 2}

    @pytest.mark.asyncio
    async def test_total_insert_failure_raises_rather_than_returning_200(self):
        class AlwaysFailing(StrictAppEventsClient):
            async def execute(self, _query, *args):
                raise RuntimeError("connection reset")

            async def executemany(self, _query, rows):
                raise RuntimeError("connection reset")

        from eden.services.app_intel.events import AppEventsUnavailableError

        svc = AppEventsService()
        with pytest.MonkeyPatch.context() as m:
            _patch_client(m, AlwaysFailing())
            with pytest.raises(AppEventsUnavailableError):
                await svc.ingest_batch(
                    "org_1", [{"name": "x", "ts": "2026-06-19T12:00:00Z"}]
                )

    @pytest.mark.asyncio
    async def test_one_poisoned_row_does_not_discard_the_batch(self):
        """executemany is one transaction; a single bad row must not
        take the other 49 with it."""

        class FailsBatchOnly(StrictAppEventsClient):
            async def executemany(self, _query, rows):
                raise RuntimeError("one row violated a constraint")

        svc = AppEventsService()
        client = FailsBatchOnly()
        events = [
            {"name": f"e{i}", "ts": "2026-06-19T12:00:00Z"} for i in range(5)
        ]
        with pytest.MonkeyPatch.context() as m:
            _patch_client(m, client)
            result = await svc.ingest_batch("org_1", events)

        assert result["accepted"] == 5
        assert client.execute_calls == 5


# ── SessionIdentityService ────────────────────────────────────────────


class TestSessionIdentityService:
    @pytest.mark.asyncio
    async def test_start_writes_to_both_tables(self):
        svc = SessionIdentityService()
        client = MagicMock()
        client.execute = AsyncMock()
        with pytest.MonkeyPatch.context() as m:
            from eden.services.app_intel import sessions as sess_mod

            async def fake_get_client():
                return client

            m.setattr(sess_mod, "_get_client", fake_get_client)
            result = await svc.start("org_1", user_id="alice")
        assert result["session_id"] != ""
        assert result["session_secret"] != ""
        assert result["expires_at"] != ""
        # 2 INSERTs (session_secrets + user_sessions)
        assert client.execute.await_count == 2

    @pytest.mark.asyncio
    async def test_start_returns_empty_when_no_postgres(self):
        svc = SessionIdentityService()
        with pytest.MonkeyPatch.context() as m:
            from eden.services.app_intel import sessions as sess_mod

            async def fake_get_client():
                return None

            m.setattr(sess_mod, "_get_client", fake_get_client)
            result = await svc.start("org_1")
        assert result["session_id"] == ""

    @pytest.mark.asyncio
    async def test_default_ttl_is_7_days(self):
        assert DEFAULT_TTL_HOURS == 24 * 7

    @pytest.mark.asyncio
    async def test_get_returns_not_found_when_no_row(self):
        svc = SessionIdentityService()
        client = MagicMock()
        client.fetchrow = AsyncMock(return_value=None)
        with pytest.MonkeyPatch.context() as m:
            from eden.services.app_intel import sessions as sess_mod

            async def fake_get_client():
                return client

            m.setattr(sess_mod, "_get_client", fake_get_client)
            result = await svc.get("org_1", "missing-session")
        assert result["not_found"] is True


# ── PresignedFeedbackService ──────────────────────────────────────────


class TestPresignedFeedbackService:
    @pytest.mark.asyncio
    async def test_default_ttl_is_3_hours(self):
        assert DEFAULT_TTL_SECONDS == 3 * 60 * 60

    @pytest.mark.asyncio
    async def test_issue_returns_token_id_and_url(self):
        svc = PresignedFeedbackService()
        client = MagicMock()
        client.execute = AsyncMock()
        with pytest.MonkeyPatch.context() as m:
            from eden.services.app_intel import presigned as pres_mod

            async def fake_get_client():
                return client

            m.setattr(pres_mod, "_get_client", fake_get_client)
            result = await svc.issue("org_1", trace_id="trace_abc", feedback_key="user_score")
        assert result["token_id"] != ""
        assert "/api/v1/feedback/tokens/" in result["url"]
        assert result["url"].endswith(result["token_id"])
        assert result["expires_at"] != ""

    @pytest.mark.asyncio
    async def test_issue_returns_empty_when_no_postgres(self):
        svc = PresignedFeedbackService()
        with pytest.MonkeyPatch.context() as m:
            from eden.services.app_intel import presigned as pres_mod

            async def fake_get_client():
                return None

            m.setattr(pres_mod, "_get_client", fake_get_client)
            result = await svc.issue("org_1", trace_id="trace_abc")
        assert result["token_id"] == ""

    @pytest.mark.asyncio
    async def test_consume_returns_none_for_unknown_token(self):
        svc = PresignedFeedbackService()
        client = MagicMock()
        client.fetchrow = AsyncMock(return_value=None)
        with pytest.MonkeyPatch.context() as m:
            from eden.services.app_intel import presigned as pres_mod

            async def fake_get_client():
                return client

            m.setattr(pres_mod, "_get_client", fake_get_client)
            result = await svc.consume("tok_unknown", "up")
        assert result is None

    @pytest.mark.asyncio
    async def test_consume_returns_none_for_expired_token(self):
        svc = PresignedFeedbackService()
        client = MagicMock()
        # token expired in the past
        client.fetchrow = AsyncMock(
            return_value={
                "token_id": "tok_xyz",
                "org_id": "org_1",
                "trace_id": "trace_abc",
                "feedback_key": "user_score",
                "expires_at": datetime.now(UTC) - timedelta(hours=1),
                "consumed_at": None,
            }
        )
        with pytest.MonkeyPatch.context() as m:
            from eden.services.app_intel import presigned as pres_mod

            async def fake_get_client():
                return client

            m.setattr(pres_mod, "_get_client", fake_get_client)
            result = await svc.consume("tok_xyz", "up")
        assert result is None

    @pytest.mark.asyncio
    async def test_consume_returns_record_for_valid_token(self):
        svc = PresignedFeedbackService()
        client = MagicMock()
        client.fetchrow = AsyncMock(
            return_value={
                "token_id": "tok_valid",
                "org_id": "org_1",
                "trace_id": "trace_abc",
                "feedback_key": "user_score",
                "expires_at": datetime.now(UTC) + timedelta(hours=1),
                "consumed_at": None,
            }
        )
        client.execute = AsyncMock()
        with pytest.MonkeyPatch.context() as m:
            from eden.services.app_intel import presigned as pres_mod

            async def fake_get_client():
                return client

            m.setattr(pres_mod, "_get_client", fake_get_client)
            result = await svc.consume("tok_valid", "up", "great answer")
        assert result is not None
        assert result["trace_id"] == "trace_abc"
        assert result["value"] == "up"
        # 1 UPDATE (consumed_at) + 1 INSERT (user_feedback) = 2 executes
        assert client.execute.await_count == 2


# ── Pydantic request models ───────────────────────────────────────────


class TestAppEventRequestModels:
    def test_app_event_requires_name(self):
        from eden.api.routes.app_events import AppEvent

        with pytest.raises(ValidationError):
            AppEvent(ts=datetime.now(UTC))

    def test_app_event_rejects_invalid_source(self):
        from eden.api.routes.app_events import AppEvent

        with pytest.raises(ValidationError):
            AppEvent(name="click", ts=datetime.now(UTC), source="watch")

    def test_app_event_accepts_browser_default(self):
        from eden.api.routes.app_events import AppEvent

        ev = AppEvent(name="click", ts=datetime.now(UTC))
        assert ev.source == "browser"

    def test_app_events_batch_min_length(self):
        from eden.api.routes.app_events import AppEventsBatch

        with pytest.raises(ValidationError):
            AppEventsBatch(events=[])

    def test_app_events_batch_accepts_one_event(self):
        from eden.api.routes.app_events import AppEventsBatch

        batch = AppEventsBatch(events=[{"name": "click", "ts": datetime.now(UTC)}])
        assert len(batch.events) == 1


class TestSessionRequestModels:
    def test_session_start_request_all_optional(self):
        from eden.api.routes.sessions import SessionStartRequest

        req = SessionStartRequest()
        assert req.user_id is None
        assert req.metadata is None
        assert req.ttl_hours is None

    def test_session_identify_requires_user_id(self):
        from eden.api.routes.sessions import SessionIdentifyRequest

        with pytest.raises(ValidationError):
            SessionIdentifyRequest(user_id="")

    def test_identify_request_accepts_traits(self):
        from eden.api.routes.sessions import IdentifyRequest

        req = IdentifyRequest(user_id="alice", traits={"plan": "pro"})
        assert req.traits == {"plan": "pro"}


class TestPresignedFeedbackRequestModels:
    def test_issue_requires_trace_id(self):
        from eden.api.routes.presigned_feedback import IssueTokenRequest

        with pytest.raises(ValidationError):
            IssueTokenRequest()

    def test_issue_default_feedback_key(self):
        from eden.api.routes.presigned_feedback import IssueTokenRequest

        req = IssueTokenRequest(trace_id="trace_abc")
        assert req.feedback_key == "user_score"
        assert req.expires_in_seconds is None

    def test_issue_rejects_ttl_too_short(self):
        from eden.api.routes.presigned_feedback import IssueTokenRequest

        with pytest.raises(ValidationError):
            IssueTokenRequest(trace_id="trace_abc", expires_in_seconds=30)

    def test_submit_accepts_value_and_comment(self):
        from eden.api.routes.presigned_feedback import SubmitFeedbackRequest

        req = SubmitFeedbackRequest(value="up", comment="helpful")
        assert req.value == "up"
        assert req.comment == "helpful"
