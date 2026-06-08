"""Tests for the Eden Python SDK."""

from __future__ import annotations

import pytest
from eden.sdk import EdenClient, EdenConfig
from eden.sdk.errors import EdenError, AuthenticationError, NotFoundError, ValidationError


class TestEdenConfig:
    def test_default_values(self):
        cfg = EdenConfig()
        assert cfg.base_url == "http://localhost:8000"
        assert cfg.timeout == 60.0
        assert cfg.max_retries == 3
        assert cfg.debug is False

    def test_load_from_kwargs(self):
        cfg = EdenConfig.load(api_key="sk_test", base_url="https://api.eden.dev")
        assert cfg.api_key == "sk_test"
        assert cfg.base_url == "https://api.eden.dev"

    def test_get_headers_with_api_key_and_org(self):
        cfg = EdenConfig(api_key="sk_test", default_org="org_123")
        headers = cfg.get_headers()
        assert headers["X-Org-Api-Key"] == "sk_test"
        assert headers["X-Org-Id"] == "org_123"

    def test_get_headers_without_auth(self):
        cfg = EdenConfig()
        headers = cfg.get_headers()
        assert headers == {}

    def test_merge_config(self):
        base = EdenConfig(base_url="http://old", timeout=30.0)
        override = EdenConfig(base_url="http://new")
        merged = base._merge(override)
        assert merged.base_url == "http://new"
        assert merged.timeout == 30.0


class TestEdenClientLifecycle:
    @pytest.mark.asyncio
    async def test_context_manager(self):
        client = EdenClient()
        async with client:
            assert client._client is not None
        assert client._client is None or client._client.is_closed

    @pytest.mark.asyncio
    async def test_close_idempotent(self):
        client = EdenClient()
        await client.close()
        await client.close()  # Should not raise


class TestErrorTaxonomy:
    def test_eden_error_str(self):
        err = EdenError("Something went wrong", request_id="req_123", suggestion="Retry")
        assert "Something went wrong" in str(err)
        assert "req_123" in str(err)
        assert "Retry" in str(err)

    def test_authentication_error_code(self):
        err = AuthenticationError("Invalid key")
        assert err.status_code == 401
        assert err.error_code == "authentication_failed"

    def test_not_found_error(self):
        err = NotFoundError("Job not found")
        assert err.status_code == 404

    def test_raise_for_status_401(self):
        with pytest.raises(AuthenticationError):
            from eden.sdk.errors import raise_for_status
            raise_for_status(401, {"detail": "Invalid API key"})

    def test_raise_for_status_404(self):
        with pytest.raises(NotFoundError):
            from eden.sdk.errors import raise_for_status
            raise_for_status(404, {"detail": "Not found"})

    def test_raise_for_status_422_with_field_errors(self):
        with pytest.raises(ValidationError) as exc:
            from eden.sdk.errors import raise_for_status
            raise_for_status(422, {
                "detail": "Validation failed",
                "data": {"field_errors": {"name": "required"}}
            })
        assert exc.value.field_errors == {"name": "required"}


class TestModels:
    def test_job_create_request(self):
        from eden.sdk.models import JobCreateRequest
        req = JobCreateRequest(description="A negotiation env")
        assert req.description == "A negotiation env"
        assert req.tags == []

    def test_job_item(self):
        from eden.sdk.models import JobItem
        job = JobItem(
            job_id="job_abc",
            status="running",
            current_stage="design",
            created_at="2024-01-01T00:00:00Z",
            updated_at="2024-01-01T00:00:00Z",
        )
        assert job.job_id == "job_abc"
