"""D.12.5 Fine-tune lineage tests — service + routes + SDK + webhook (15 tests).

Covers:

* Service: register_run happy + idempotent on (provider, provider_fine_tune_id),
  update_status, get_run, list_runs_for_org with status filter,
  link_dataset_to_traces, record_trace_usage, get_lineage_for_run
  (backward + forward), detect_data_drift below threshold (no hook),
  detect_data_drift above threshold (fires hook).
* Routes: GET /v1/fine_tuning_runs, POST /v1/fine_tuning_runs,
  GET /v1/fine_tuning_runs/{id}, GET /v1/fine_tuning_runs/{id}/lineage,
  POST /v1/fine_tuning_runs/{id}/dataset_traces,
  POST /v1/fine_tuning_runs/{id}/trace_usage,
  POST /v1/fine_tuning_runs/{id}/drift_check,
  POST /v1/webhooks/openai/fine_tuning (HMAC verify + idempotent).
* SDK: register_run happy, parse_openai_webhook_payload,
  build_fine_tune_attributes.

Auth stubs use ``app.dependency_overrides`` (the proven
FastAPI pattern from the D.12.1-4 tests).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient


# ── helpers ───────────────────────────────────────────────────────────


_RUN_ID = "00000000-0000-0000-0000-000000000055"
_DATASET_ID = "00000000-0000-0000-0000-000000000066"
_TRACE_ID = "00000000-0000-0000-0000-000000000077"


def _run_row(
    status: str = "pending",
    provider: str = "openai",
    provider_fine_tune_id: str | None = "ftjob-1",
    eval_results: dict | None = None,
):
    now = datetime.now(UTC)
    return {
        "id": _RUN_ID,
        "org_id": "org-1",
        "provider": provider,
        "provider_fine_tune_id": provider_fine_tune_id,
        "base_model": "gpt-4o-mini-2024-07-18",
        "fine_tuned_model": "ft:gpt-4o-mini:org::custom",
        "dataset_id": _DATASET_ID,
        "training_params": {"hyperparameters": {"n_epochs": "auto"}},
        "status": status,
        "eval_results": eval_results,
        "created_at": now,
        "completed_at": None,
    }


def _linkage_row(dataset_id: str = _DATASET_ID, trace_id: str = _TRACE_ID):
    return {
        "dataset_id": dataset_id,
        "trace_id": trace_id,
        "span_id": None,
        "added_at": datetime.now(UTC),
    }


def _usage_row(run_id: str = _RUN_ID, trace_id: str = _TRACE_ID):
    return {
        "fine_tuning_run_id": run_id,
        "trace_id": trace_id,
        "first_used_at": datetime.now(UTC),
    }


async def _fake_user() -> dict:
    return {"id": "u-1", "email": "t@test.io", "sub": "u-1"}


async def _fake_member() -> dict:
    return {"id": "u-1", "role": "member", "org_id": "org-1"}


async def _fake_admin() -> dict:
    return {"id": "u-1", "role": "admin", "org_id": "org-1"}


@pytest.fixture
def fine_tune_client(mock_postgres_client: MagicMock) -> TestClient:
    """TestClient with the fine-tune route's auth deps stubbed."""
    from eden.api.app import app
    from eden.api.deps import (
        get_current_user,
        require_org_admin,
        require_org_member,
    )
    app.dependency_overrides[get_current_user] = _fake_user
    app.dependency_overrides[require_org_member] = _fake_member
    app.dependency_overrides[require_org_admin] = _fake_admin
    try:
        client = TestClient(app)
        client.cookies.set("authorization", "test-token-for-default-deny")
        yield client
    finally:
        app.dependency_overrides.clear()


# ── service tests ─────────────────────────────────────────────────────


class TestFineTuneLineageService:
    """7 service-level tests."""

    async def test_register_run_returns_id(
        self, mock_postgres_client: MagicMock,
    ):
        from eden.services.observability import get_fine_tune_service
        svc = get_fine_tune_service()
        mock_postgres_client.fetchrow = AsyncMock(return_value={"id": _RUN_ID})
        run_id = await svc.register_run(
            "org-1",
            provider="openai",
            base_model="gpt-4o-mini-2024-07-18",
            fine_tuned_model="ft:gpt-4o-mini:org::custom",
            dataset_id=_DATASET_ID,
            provider_fine_tune_id="ftjob-1",
            status="pending",
        )
        assert run_id == _RUN_ID
        # SQL was the upsert ON CONFLICT (provider, provider_fine_tune_id)
        sql = mock_postgres_client.fetchrow.call_args.args[0]
        assert "ON CONFLICT (provider, provider_fine_tune_id)" in sql

    async def test_register_run_invalid_status_raises(self):
        """Service layer validates status before touching the DB."""
        from eden.services.observability import get_fine_tune_service
        svc = get_fine_tune_service()
        with pytest.raises(ValueError, match="unknown status"):
            await svc.register_run(
                "org-1",
                provider="openai",
                base_model="gpt-4o-mini-2024-07-18",
                fine_tuned_model="ft:gpt-4o-mini:org::custom",
                dataset_id=_DATASET_ID,
                status="wontfix",
            )

    async def test_update_status_completed_at_set_for_succeeded(
        self, mock_postgres_client: MagicMock,
    ):
        from eden.services.observability import get_fine_tune_service
        svc = get_fine_tune_service()
        mock_postgres_client.execute = AsyncMock(return_value="UPDATE 1")
        ok = await svc.update_status(
            _RUN_ID, status="succeeded",
            eval_results={"mean_score": 0.92},
        )
        assert ok is True
        # SQL flipped status + set completed_at for terminal states
        sql = mock_postgres_client.execute.call_args.args[0]
        assert "completed_at = CASE" in sql
        assert "'succeeded', 'failed'" in sql

    async def test_list_runs_with_status_filter(
        self, mock_postgres_client: MagicMock,
    ):
        from eden.services.observability import get_fine_tune_service
        svc = get_fine_tune_service()
        mock_postgres_client.fetch = AsyncMock(return_value=[
            _run_row(status="succeeded"),
        ])
        rows = await svc.list_runs_for_org(
            "org-1", status="succeeded", limit=50,
        )
        assert len(rows) == 1
        # Filter clause was included
        sql = mock_postgres_client.fetch.call_args.args[0]
        assert "status = $2" in sql

    async def test_link_dataset_to_traces_idempotent(
        self, mock_postgres_client: MagicMock,
    ):
        from eden.services.observability import get_fine_tune_service
        svc = get_fine_tune_service()
        # 1 successful insert, 1 conflict
        mock_postgres_client.execute = AsyncMock(
            side_effect=["INSERT 0 1", "INSERT 0 0"],
        )
        inserted = await svc.link_dataset_to_traces(
            _DATASET_ID,
            trace_ids=[_TRACE_ID, "00000000-0000-0000-0000-0000000000aa"],
        )
        assert inserted == 1

    async def test_get_lineage_for_run_returns_backward_and_forward(
        self, mock_postgres_client: MagicMock,
    ):
        from eden.services.observability import get_fine_tune_service
        svc = get_fine_tune_service()
        mock_postgres_client.fetchrow = AsyncMock(return_value=_run_row())
        # 2 calls: backward, forward
        mock_postgres_client.fetch = AsyncMock(side_effect=[
            [_linkage_row(trace_id=_TRACE_ID),
             _linkage_row(trace_id="00000000-0000-0000-0000-0000000000aa")],
            [_usage_row(trace_id=_TRACE_ID)],
        ])
        lineage = await svc.get_lineage_for_run(_RUN_ID)
        assert lineage is not None
        assert lineage["run"]["id"] == _RUN_ID
        assert len(lineage["backward"]["trace_ids"]) == 2
        assert len(lineage["forward"]["trace_ids"]) == 1
        assert lineage["forward"]["fine_tuned_model"] == "ft:gpt-4o-mini:org::custom"

    async def test_detect_data_drift_above_threshold(
        self, mock_postgres_client: MagicMock,
    ):
        """When the current run's z-score against the prior
        window's mean + stdev exceeds the threshold, the
        detector returns a drift summary + fires the hook.
        """
        from eden.services.observability import get_fine_tune_service
        svc = get_fine_tune_service()
        # Target: mean_score=0.40 (regression)
        # Prior 5: [0.85, 0.86, 0.87, 0.85, 0.86] → mean ~0.858, stdev ~0.008
        # z = (0.40 - 0.858) / 0.008 ≈ -57 (huge drift, fires hook)
        mock_postgres_client.fetchrow = AsyncMock(return_value={
            "id": _RUN_ID,
            "org_id": "org-1",
            "base_model": "gpt-4o-mini-2024-07-18",
            "eval_results": {"mean_score": 0.40},
            "created_at": datetime.now(UTC),
            "status": "succeeded",
        })
        mock_postgres_client.fetch = AsyncMock(return_value=[
            {"eval_results": {"mean_score": s}}
            for s in [0.85, 0.86, 0.87, 0.85, 0.86]
        ])
        summary = await svc.detect_data_drift(
            _RUN_ID, window=5, z_threshold=2.0,
        )
        assert summary is not None
        assert summary["drift"] is True
        assert summary["direction"] == "regression"
        assert summary["z_score"] < -2.0

    async def test_detect_data_drift_below_threshold_returns_none(
        self, mock_postgres_client: MagicMock,
    ):
        """When the current run's z-score is within bounds,
        the detector returns None (no hook fired)."""
        from eden.services.observability import get_fine_tune_service
        svc = get_fine_tune_service()
        mock_postgres_client.fetchrow = AsyncMock(return_value={
            "id": _RUN_ID,
            "org_id": "org-1",
            "base_model": "gpt-4o-mini-2024-07-18",
            "eval_results": {"mean_score": 0.86},
            "created_at": datetime.now(UTC),
            "status": "succeeded",
        })
        # Prior 5: tight around 0.86; current is 0.86 → z ≈ 0
        mock_postgres_client.fetch = AsyncMock(return_value=[
            {"eval_results": {"mean_score": s}}
            for s in [0.86, 0.86, 0.86, 0.86, 0.86]
        ])
        summary = await svc.detect_data_drift(
            _RUN_ID, window=5, z_threshold=2.0,
        )
        assert summary is None


# ── route tests ───────────────────────────────────────────────────────


class TestFineTuneRoutes:
    """5 route tests."""

    def test_list_fine_tuning_runs(
        self, mock_postgres_client: MagicMock, fine_tune_client: TestClient,
    ):
        mock_postgres_client.fetch = AsyncMock(return_value=[
            _run_row(status="succeeded"),
        ])
        resp = fine_tune_client.get(
            "/v1/fine_tuning_runs?org_id=org-1",
            headers={"X-Org-Id": "org-1"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "ok"
        assert body["count"] == 1
        assert body["data"][0]["status"] == "succeeded"

    def test_post_fine_tuning_run_registers(
        self, mock_postgres_client: MagicMock, fine_tune_client: TestClient,
    ):
        mock_postgres_client.fetchrow = AsyncMock(return_value={"id": _RUN_ID})
        resp = fine_tune_client.post(
            "/v1/fine_tuning_runs",
            json={
                "provider": "openai",
                "base_model": "gpt-4o-mini-2024-07-18",
                "fine_tuned_model": "ft:gpt-4o-mini:org::custom",
                "dataset_id": _DATASET_ID,
                "provider_fine_tune_id": "ftjob-1",
                "status": "pending",
            },
            headers={"X-Org-Id": "org-1"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "ok"
        assert body["data"]["id"] == _RUN_ID

    def test_get_lineage_route(
        self, mock_postgres_client: MagicMock, fine_tune_client: TestClient,
    ):
        mock_postgres_client.fetchrow = AsyncMock(return_value=_run_row())
        mock_postgres_client.fetch = AsyncMock(side_effect=[
            [_linkage_row(trace_id=_TRACE_ID)],
            [_usage_row(trace_id=_TRACE_ID)],
        ])
        resp = fine_tune_client.get(
            f"/v1/fine_tuning_runs/{_RUN_ID}/lineage",
            headers={"X-Org-Id": "org-1"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "ok"
        assert body["data"]["run"]["id"] == _RUN_ID
        assert len(body["data"]["backward"]["trace_ids"]) == 1
        assert len(body["data"]["forward"]["trace_ids"]) == 1

    def test_post_link_dataset_traces(
        self, mock_postgres_client: MagicMock, fine_tune_client: TestClient,
    ):
        mock_postgres_client.fetchrow = AsyncMock(return_value=_run_row())
        mock_postgres_client.execute = AsyncMock(return_value="INSERT 0 1")
        resp = fine_tune_client.post(
            f"/v1/fine_tuning_runs/{_RUN_ID}/dataset_traces",
            json={"trace_ids": [_TRACE_ID]},
            headers={"X-Org-Id": "org-1"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "ok"
        assert body["data"]["linked"] == 1

    def test_post_drift_check_no_drift(
        self, mock_postgres_client: MagicMock, fine_tune_client: TestClient,
    ):
        # Target row with no eval_results → returns "no drift" envelope
        mock_postgres_client.fetchrow = AsyncMock(return_value={
            "id": _RUN_ID,
            "org_id": "org-1",
            "base_model": "gpt-4o-mini-2024-07-18",
            "eval_results": None,
            "created_at": datetime.now(UTC),
            "status": "succeeded",
        })
        resp = fine_tune_client.post(
            f"/v1/fine_tuning_runs/{_RUN_ID}/drift_check",
            headers={"X-Org-Id": "org-1"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "ok"
        assert body["data"]["drift"] is False


# ── webhook tests ─────────────────────────────────────────────────────


class TestOpenAIFineTuneWebhook:
    """3 webhook tests."""

    def test_webhook_returns_503_when_secret_unset(
        self, mock_postgres_client: MagicMock, fine_tune_client: TestClient,
        monkeypatch,
    ):
        monkeypatch.delenv(
            "OPENAI_FINE_TUNE_WEBHOOK_SECRET", raising=False,
        )
        resp = fine_tune_client.post(
            "/v1/webhooks/openai/fine_tuning",
            json={"type": "fine_tuning.job.succeeded", "data": {"id": "ftjob-1"}},
            headers={"X-Org-Id": "org-1"},
        )
        assert resp.status_code == 503, resp.text

    def test_webhook_returns_401_on_bad_signature(
        self, mock_postgres_client: MagicMock, fine_tune_client: TestClient,
        monkeypatch,
    ):
        monkeypatch.setenv(
            "OPENAI_FINE_TUNE_WEBHOOK_SECRET", "test-secret-xyz",
        )
        resp = fine_tune_client.post(
            "/v1/webhooks/openai/fine_tuning",
            json={"type": "fine_tuning.job.succeeded", "data": {"id": "ftjob-1"}},
            headers={
                "X-Org-Id": "org-1",
                "OpenAI-Webhook-Signature": "t=1234,v1=deadbeef",
            },
        )
        assert resp.status_code == 401, resp.text

    def test_webhook_ingests_succeeded_event_idempotently(
        self, mock_postgres_client: MagicMock, fine_tune_client: TestClient,
        monkeypatch,
    ):
        """A correctly-signed ``fine_tuning.job.succeeded``
        event persists the run (idempotent on
        ``(provider, provider_fine_tune_id)``).
        """
        monkeypatch.setenv(
            "OPENAI_FINE_TUNE_WEBHOOK_SECRET", "test-secret-xyz",
        )
        body_dict = {
            "id": "evt-1",
            "type": "fine_tuning.job.succeeded",
            "data": {
                "id": "ftjob-1",
                "model": "gpt-4o-mini-2024-07-18",
                "fine_tuned_model": "ft:gpt-4o-mini:org::custom",
                "training_file": "file-abc",
                "trained_tokens": 12345,
                "hyperparameters": {"n_epochs": "auto"},
                "eval_results": {"mean_score": 0.92},
            },
        }
        body_bytes = json.dumps(body_dict).encode("utf-8")
        ts = str(int(time.time()))
        sig = hmac.new(
            b"test-secret-xyz",
            f"{ts}.".encode("utf-8") + body_bytes,
            hashlib.sha256,
        ).hexdigest()
        mock_postgres_client.fetchrow = AsyncMock(return_value={"id": _RUN_ID})
        resp = fine_tune_client.post(
            "/v1/webhooks/openai/fine_tuning",
            content=body_bytes,
            headers={
                "X-Org-Id": "org-1",
                "Content-Type": "application/json",
                "OpenAI-Webhook-Signature": f"t={ts},v1={sig}",
            },
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "ok"
        assert body["data"]["internal_status"] == "succeeded"
        # Bound args: args[0]=SQL, args[1]=org_id, args[2]=provider,
        # args[3]=provider_fine_tune_id, args[4]=base_model, ...
        args = mock_postgres_client.fetchrow.call_args.args
        assert args[2] == "openai"               # provider
        assert args[3] == "ftjob-1"              # provider_fine_tune_id


# ── SDK tests ─────────────────────────────────────────────────────────


class TestFineTuneSdk:
    """3 SDK tests."""

    async def test_register_run_persists(self, mock_postgres_client: MagicMock):
        from eden.sdk.fine_tune import register_run
        mock_postgres_client.fetchrow = AsyncMock(return_value={"id": _RUN_ID})
        run_id = await register_run(
            org_id="org-1",
            provider="openai",
            base_model="gpt-4o-mini-2024-07-18",
            fine_tuned_model="ft:gpt-4o-mini:org::custom",
            dataset_id=_DATASET_ID,
            provider_fine_tune_id="ftjob-1",
            status="succeeded",
            eval_results={"mean_score": 0.92},
        )
        assert run_id == _RUN_ID

    def test_parse_openai_webhook_payload(self):
        from eden.sdk.fine_tune import parse_openai_webhook_payload
        payload = {
            "id": "evt-1",
            "type": "fine_tuning.job.succeeded",
            "data": {
                "id": "ftjob-1",
                "model": "gpt-4o-mini-2024-07-18",
                "fine_tuned_model": "ft:gpt-4o-mini:org::custom",
                "hyperparameters": {"n_epochs": "auto"},
                "trained_tokens": 12345,
                "eval_results": {"mean_score": 0.92},
            },
        }
        parsed = parse_openai_webhook_payload(payload)
        assert parsed["event_type"] == "fine_tuning.job.succeeded"
        assert parsed["fine_tune_id"] == "ftjob-1"
        assert parsed["internal_status"] == "succeeded"
        assert parsed["base_model"] == "gpt-4o-mini-2024-07-18"
        assert parsed["fine_tuned_model"] == "ft:gpt-4o-mini:org::custom"
        assert parsed["training_params"]["trained_tokens"] == 12345
        assert parsed["eval_results"]["mean_score"] == 0.92
        assert parsed["ignored"] is False

    def test_parse_openai_webhook_payload_unknown_event_is_ignored(self):
        """Unknown event types are surfaced with ``ignored=True``."""
        from eden.sdk.fine_tune import parse_openai_webhook_payload
        payload = {
            "id": "evt-1",
            "type": "fine_tuning.job.unknown_future_event",
            "data": {"id": "ftjob-1"},
        }
        parsed = parse_openai_webhook_payload(payload)
        assert parsed["ignored"] is True
        assert parsed["internal_status"] is None

    def test_build_fine_tune_attributes(self):
        from eden.sdk.fine_tune import build_fine_tune_attributes
        attrs = build_fine_tune_attributes(
            run_id=_RUN_ID,
            provider="openai",
            base_model="gpt-4o-mini-2024-07-18",
            fine_tuned_model="ft:gpt-4o-mini:org::custom",
            status="succeeded",
            dataset_id=_DATASET_ID,
            eval_results={"mean_score": 0.92},
        )
        assert "fine_tune" in attrs
        ft = attrs["fine_tune"]
        assert ft["run_id"] == _RUN_ID
        assert ft["provider"] == "openai"
        assert ft["status"] == "succeeded"
        assert ft["eval_results"]["mean_score"] == 0.92
