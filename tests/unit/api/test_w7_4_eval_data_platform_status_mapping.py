"""W7.4 — eval / data-platform route status mapping (no unintended 500s).

Client-shaped Postgres errors → 4xx; infra / other DB failures → 503.
Preserves Wave 5.2 RuntimeError → 503 for offline experiments.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from eden.api.utils.safe_error import map_db_exception, raise_mapped_db_error

ORG = "00000000-0000-0000-0000-000000000001"
USER = "00000000-0000-0000-0000-000000000002"
DS = "00000000-0000-0000-0000-000000000003"
PG = "00000000-0000-0000-0000-000000000004"


def test_map_db_exception_unique_is_409():
    status, detail = map_db_exception(
        Exception("duplicate key value violates unique constraint"),
        fallback="x",
        unique_detail="already exists",
    )
    assert status == 409
    assert detail == "already exists"


def test_map_db_exception_bad_uuid_is_400():
    status, detail = map_db_exception(
        Exception('invalid input syntax for type uuid: "org_bad"'),
        fallback="x",
    )
    assert status == 400


def test_map_db_exception_fk_is_404():
    status, detail = map_db_exception(
        Exception('insert or update violates foreign key constraint'),
        fallback="x",
    )
    assert status == 404


def test_map_db_exception_other_is_503():
    status, detail = map_db_exception(
        Exception("connection reset by peer"),
        fallback="service down",
    )
    assert status == 503
    assert detail == "service down"


def test_raise_mapped_db_error_raises_http():
    with pytest.raises(HTTPException) as ei:
        raise_mapped_db_error(
            Exception("connection reset by peer"),
            fallback="down",
        )
    assert ei.value.status_code == 503


@pytest.mark.asyncio
async def test_create_dataset_infra_is_503_not_400():
    from eden.api.routes import datasets_hub as mod

    hub = MagicMock()
    hub.create_dataset = AsyncMock(side_effect=Exception("connection reset by peer"))

    with patch.object(mod, "DatasetHub", return_value=hub):
        body = mod.CreateDatasetRequest(name="evals")
        with pytest.raises(HTTPException) as ei:
            await mod.create_dataset(body, org_id=ORG, user={"user_id": USER})
        assert ei.value.status_code == 503


@pytest.mark.asyncio
async def test_create_dataset_unique_is_409():
    from eden.api.routes import datasets_hub as mod

    hub = MagicMock()
    hub.create_dataset = AsyncMock(
        side_effect=Exception("duplicate key value violates unique constraint")
    )

    with patch.object(mod, "DatasetHub", return_value=hub):
        body = mod.CreateDatasetRequest(name="evals")
        with pytest.raises(HTTPException) as ei:
            await mod.create_dataset(body, org_id=ORG, user={"user_id": USER})
        assert ei.value.status_code == 409


@pytest.mark.asyncio
async def test_create_offline_experiment_missing_dataset_is_404():
    from eden.api.routes import experiments_offline as mod

    runner = MagicMock()
    runner.create = AsyncMock(side_effect=ValueError("dataset not found"))

    with patch.object(mod, "OfflineExperimentRunner", return_value=runner):
        body = mod.CreateExperimentRequest(name="exp", dataset_id=DS)
        with pytest.raises(HTTPException) as ei:
            await mod.create_offline_experiment(
                body, org_id=ORG, user={"user_id": USER}
            )
        assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_create_offline_experiment_runtime_is_503():
    """Wave 5.2 contract: RuntimeError (no-PG) → 503."""
    from eden.api.routes import experiments_offline as mod

    runner = MagicMock()
    runner.create = AsyncMock(side_effect=RuntimeError("database unavailable"))

    with patch.object(mod, "OfflineExperimentRunner", return_value=runner):
        body = mod.CreateExperimentRequest(name="exp", dataset_id=DS)
        with pytest.raises(HTTPException) as ei:
            await mod.create_offline_experiment(
                body, org_id=ORG, user={"user_id": USER}
            )
        assert ei.value.status_code == 503


@pytest.mark.asyncio
async def test_list_offline_experiments_runtime_still_503():
    from eden.api.routes import experiments_offline as mod

    runner = MagicMock()
    runner.list_experiments = AsyncMock(
        side_effect=RuntimeError("database unavailable")
    )

    with patch.object(mod, "OfflineExperimentRunner", return_value=runner):
        with pytest.raises(HTTPException) as ei:
            await mod.list_offline_experiments(org_id=ORG, user={"user_id": USER})
        assert ei.value.status_code == 503


@pytest.mark.asyncio
async def test_get_playground_bad_uuid_is_400():
    from eden.api.routes import playgrounds as mod

    svc = MagicMock()
    svc.get = AsyncMock(
        side_effect=Exception('invalid input syntax for type uuid: "pg_bad"')
    )

    with patch.object(mod, "PlaygroundService", return_value=svc):
        with pytest.raises(HTTPException) as ei:
            await mod.get_playground(
                org_id=ORG, playground_id="pg_bad", user={"user_id": USER}
            )
        assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_promote_playground_not_found_is_404():
    from eden.api.routes import playgrounds as mod

    svc = MagicMock()
    svc.promote_experiment = AsyncMock(side_effect=ValueError("playground not found"))

    with patch.object(mod, "PlaygroundService", return_value=svc):
        body = mod.PromoteExperimentRequest(dataset_id=DS)
        with pytest.raises(HTTPException) as ei:
            await mod.promote_playground_experiment(
                body, org_id=ORG, playground_id=PG, user={"user_id": USER}
            )
        assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_promote_playground_missing_dataset_id_is_400():
    from eden.api.routes import playgrounds as mod

    svc = MagicMock()
    svc.promote_experiment = AsyncMock(
        side_effect=ValueError("dataset_id required to promote")
    )

    with patch.object(mod, "PlaygroundService", return_value=svc):
        body = mod.PromoteExperimentRequest()
        with pytest.raises(HTTPException) as ei:
            await mod.promote_playground_experiment(
                body, org_id=ORG, playground_id=PG, user={"user_id": USER}
            )
        assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_execute_sql_infra_is_503():
    from eden.api.routes import sql_query as mod
    from eden.observability.sql_executor import SqlExecutor

    pg = MagicMock()
    body = mod.SqlExecuteRequest(sql="SELECT 1")

    with (
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=pg)),
        patch.object(
            SqlExecutor,
            "execute",
            AsyncMock(side_effect=Exception("connection reset by peer")),
        ),
    ):
        with pytest.raises(HTTPException) as ei:
            await mod.execute_sql(body, org_id=ORG, user={"user_id": USER})
        assert ei.value.status_code == 503


@pytest.mark.asyncio
async def test_token_usage_bad_uuid_is_400():
    from eden.api.routes import analytics as mod

    client = MagicMock()
    client.fetch = AsyncMock(
        side_effect=Exception('invalid input syntax for type uuid: "org_bad"')
    )

    with patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)):
        with pytest.raises(HTTPException) as ei:
            await mod.token_usage(org_id="org_bad", days=7, _user={"user_id": USER})
        assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_token_usage_infra_is_503():
    from eden.api.routes import analytics as mod

    client = MagicMock()
    client.fetch = AsyncMock(side_effect=Exception("connection reset by peer"))

    with patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)):
        with pytest.raises(HTTPException) as ei:
            await mod.token_usage(org_id=ORG, days=7, _user={"user_id": USER})
        assert ei.value.status_code == 503


@pytest.mark.asyncio
async def test_get_funnel_infra_is_503():
    from eden.api.routes import analytics_v2 as mod

    with patch.object(
        mod, "funnel", AsyncMock(side_effect=Exception("connection reset by peer"))
    ):
        with pytest.raises(HTTPException) as ei:
            await mod.get_funnel(
                org_id=ORG,
                steps="signup,job_created",
                window_days=30,
                user={"user_id": USER},
            )
        assert ei.value.status_code == 503


@pytest.mark.asyncio
async def test_annotate_item_not_found_is_404():
    from eden.api.routes import labeling as mod

    svc = MagicMock()
    svc.annotate = AsyncMock(side_effect=ValueError("item not found"))

    with (
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=MagicMock())),
        patch.object(mod, "LabelingService", return_value=svc),
    ):
        body = mod.AnnotateRequest(item_id=DS, label={"score": 1}, confidence=0.5)
        with pytest.raises(HTTPException) as ei:
            await mod.annotate(body, org_id=ORG, user={"user_id": USER, "id": USER})
        assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_annotate_runtime_is_503():
    from eden.api.routes import labeling as mod

    svc = MagicMock()
    svc.annotate = AsyncMock(side_effect=RuntimeError("annotation vanished after upsert"))

    with (
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=MagicMock())),
        patch.object(mod, "LabelingService", return_value=svc),
    ):
        body = mod.AnnotateRequest(item_id=DS, label={"score": 1}, confidence=0.5)
        with pytest.raises(HTTPException) as ei:
            await mod.annotate(body, org_id=ORG, user={"user_id": USER, "id": USER})
        assert ei.value.status_code == 503


@pytest.mark.asyncio
async def test_create_queue_infra_is_503():
    from eden.api.routes import labeling as mod

    with patch(
        "eden.evaluation.labeling_queues.LabelingQueueService.create_queue",
        AsyncMock(side_effect=Exception("connection reset by peer")),
    ):
        body = mod.CreateQueueRequest(name="q1")
        with pytest.raises(HTTPException) as ei:
            await mod.create_queue(body, org_id=ORG)
        assert ei.value.status_code == 503


@pytest.mark.asyncio
async def test_reprocess_quarantine_empty_ids_is_400():
    from eden.api.routes import data_platform as mod

    body = mod.QuarantineReviewRequest(quarantine_ids=[])
    with pytest.raises(HTTPException) as ei:
        await mod.reprocess_quarantine(
            org_id=ORG, request=body, user={"user_id": USER}
        )
    assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_list_quarantine_infra_is_503():
    from eden.api.routes import data_platform as mod

    client = MagicMock()
    client.fetchval = AsyncMock(side_effect=Exception("connection reset by peer"))

    with patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)):
        with pytest.raises(HTTPException) as ei:
            await mod.list_quarantine(
                org_id=ORG,
                resolution=None,
                limit=10,
                offset=0,
                user={"user_id": USER},
            )
        assert ei.value.status_code == 503


@pytest.mark.asyncio
async def test_list_rows_bad_filter_json_is_400():
    from eden.api.routes import datasets_spreadsheet as mod

    with patch.object(mod, "_assert_dataset_org", AsyncMock(return_value=None)):
        with pytest.raises(HTTPException) as ei:
            await mod.list_rows_route(
                org_id=ORG,
                dataset_id=DS,
                filter="{not-json",
                sort=None,
                limit=10,
                offset=0,
                user={"user_id": USER},
            )
        assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_add_row_infra_is_503():
    from eden.api.routes import datasets_spreadsheet as mod

    svc = MagicMock()
    svc.add_row = AsyncMock(side_effect=Exception("connection reset by peer"))

    with (
        patch.object(mod, "_assert_dataset_org", AsyncMock(return_value=None)),
        patch.object(mod, "_spreadsheet_svc", AsyncMock(return_value=svc)),
    ):
        body = mod.AddRowRequest(input="hello")
        with pytest.raises(HTTPException) as ei:
            await mod.add_row_route(
                body, org_id=ORG, dataset_id=DS, user={"user_id": USER}
            )
        assert ei.value.status_code == 503
