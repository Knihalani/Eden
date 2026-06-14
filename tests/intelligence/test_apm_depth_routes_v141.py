"""Route tests for Cat 22 v1.4.1 — tail-sampling + K8s + Pyroscope endpoints.

Exercises the 5 new routes added on top of the v1.4
core surface:

* ``POST /sampling/evaluate``
* ``GET  /sampling/stats``
* ``POST /k8s/enrich``
* ``POST /k8s/enrich-batch``
* ``GET  /k8s/detect``
* ``GET  /profiles/{trace_id}``
* ``GET  /profiles/{trace_id}/{step_index}``
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _fake_user() -> dict:
    return {"sub": "test-user", "org_id": "org_test"}


@pytest.fixture(scope="module")
def apm_depth_app() -> FastAPI:
    from eden.api.deps import get_current_user
    from eden.api.routes.intelligence_apm_depth import router
    from eden.config import get_settings

    settings = get_settings()
    settings.intelligence_gap_v0 = True

    app = FastAPI(title="eden-apm-depth-v141-test")
    app.dependency_overrides[get_current_user] = _fake_user
    app.include_router(router)
    return app


# ─── Tail-sampling routes ────────────────────────────────────────


class TestSamplingRoutes:
    def test_sampling_evaluate_keeps_error(
        self, apm_depth_app: FastAPI
    ) -> None:
        client = TestClient(apm_depth_app)
        r = client.post(
            "/orgs/org_test/intelligence/apm-depth/sampling/evaluate",
            json={
                "trace_id": "trace-1",
                "spans": [{"status_code": "ERROR", "duration_ms": 50}],
            },
        )
        assert r.status_code == 200
        body = r.json()
        assert body["data"]["verdict"] == "keep"
        assert body["data"]["rule"] == "keep_if_error"

    def test_sampling_stats_returns_envelope(
        self, apm_depth_app: FastAPI
    ) -> None:
        from eden.apm_depth import reset_tail_sampler

        reset_tail_sampler()
        client = TestClient(apm_depth_app)
        r = client.get(
            "/orgs/org_test/intelligence/apm-depth/sampling/stats"
        )
        assert r.status_code == 200
        body = r.json()
        assert "kept_traces" in body["data"]
        assert "dropped_traces" in body["data"]
        assert "drop_rate" in body["data"]
        assert "memory_gb_estimate" in body["data"]
        reset_tail_sampler()


# ─── K8s routes ───────────────────────────────────────────────────


class TestK8sRoutes:
    def test_k8s_enrich_route(self, apm_depth_app: FastAPI) -> None:
        client = TestClient(apm_depth_app)
        r = client.post(
            "/orgs/org_test/intelligence/apm-depth/k8s/enrich",
            json={
                "attributes": {"service.name": "api"},
                "env": {
                    "KUBERNETES_POD_NAME": "my-pod",
                    "KUBERNETES_NAMESPACE": "prod",
                },
            },
        )
        assert r.status_code == 200
        body = r.json()
        assert body["data"]["k8s"]["k8s.pod.name"] == "my-pod"
        assert body["data"]["attributes"]["k8s.pod.name"] == "my-pod"

    def test_k8s_enrich_batch_route(
        self, apm_depth_app: FastAPI
    ) -> None:
        client = TestClient(apm_depth_app)
        r = client.post(
            "/orgs/org_test/intelligence/apm-depth/k8s/enrich-batch",
            json={
                "spans": [
                    {
                        "name": "s1",
                        "resource": {
                            "attributes": {"k8s.pod.name": "p1"}
                        },
                        "attributes": {},
                    }
                ]
            },
        )
        assert r.status_code == 200
        body = r.json()
        assert body["data"]["k8s_enriched_count"] == 1

    def test_k8s_detect_route(self, apm_depth_app: FastAPI) -> None:
        client = TestClient(apm_depth_app)
        r = client.get(
            "/orgs/org_test/intelligence/apm-depth/k8s/detect"
        )
        assert r.status_code == 200
        body = r.json()
        assert "is_k8s" in body["data"]
        assert "sources_present" in body["data"]


# ─── Pyroscope routes ─────────────────────────────────────────────


class TestPyroscopeRoutes:
    def test_get_profile_link_returns_envelope(
        self, apm_depth_app: FastAPI
    ) -> None:
        with patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=None),
        ):
            client = TestClient(apm_depth_app)
            r = client.get(
                "/orgs/org_test/intelligence/apm-depth/profiles/trace-1/2"
            )
        assert r.status_code == 200
        body = r.json()
        assert body["data"]["trace_id"] == "trace-1"
        assert body["data"]["step_index"] == 2
        assert "profile_id" in body["data"]
        assert "pyroscope_url" in body["data"]

    def test_list_profile_links_returns_envelope(
        self, apm_depth_app: FastAPI
    ) -> None:
        with patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=None),
        ):
            client = TestClient(apm_depth_app)
            r = client.get(
                "/orgs/org_test/intelligence/apm-depth/profiles/trace-1"
            )
        assert r.status_code == 200
        body = r.json()
        assert body["data"]["trace_id"] == "trace-1"
        assert "links" in body["data"]


# ─── Chained OTel v1.41 + K8s enrich ─────────────────────────────


class TestChainedEnrichRoute:
    def test_enrich_with_resource_attributes(
        self, apm_depth_app: FastAPI
    ) -> None:
        client = TestClient(apm_depth_app)
        r = client.post(
            "/orgs/org_test/intelligence/apm-depth/enrich",
            json={
                "attributes": {"gen_ai.client.token.usage": 100},
                "resource_attributes": {"k8s.pod.name": "p1"},
            },
        )
        assert r.status_code == 200
        body = r.json()
        # OTel dual-emit
        assert body["data"]["spec"] == "v141"
        assert body["data"]["attributes"]["gen_ai.usage.input_tokens"] == 100
        # K8s attributes stamped in the chained path
        assert body["data"]["k8s"]["k8s.pod.name"] == "p1"
        assert "k8s_sources" in body["data"]
