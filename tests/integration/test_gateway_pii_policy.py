"""Integration tests for the gateway PII policy contract.

Covers:
  * per-tenant ``mode="off"`` (system designed to use the PII)
  * per-request opt-out via ``X-PII-Bypass: true`` header
  * per-request opt-out via ``pii_filter_enabled: false`` body field
  * per-tenant ``mode="fail_closed"`` returning 422 on credential
  * default categories match the source-of-truth list in
    ``eden.data_platform.pii._DEFAULT_CATEGORIES``

These tests stub the per-tenant policy resolver so they're
independent of Postgres. The DB-backed path is covered by the
``tests/unit/llmops/policy_cache`` tests.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock
from collections import OrderedDict

import pytest
from fastapi.testclient import TestClient


class _StubUsage:
    def __init__(self, prompt=4, completion=2, total=6):
        self.prompt_tokens = prompt
        self.completion_tokens = completion
        self.total_tokens = total


class _StubMessage:
    def __init__(self, role="assistant", content="ok"):
        self.role = role
        self.content = content
        self.refusal = None
        self.tool_calls = None
        self.function_call = None
        self.audio = None


class _StubChoice:
    def __init__(self, message=None):
        self.index = 0
        self.message = message or _StubMessage()
        self.finish_reason = "stop"
        self.logprobs = None


class _StubChatResponse:
    def __init__(self, content="ok"):
        self.id = "chatcmpl-stub"
        self.object = "chat.completion"
        self.created = 1700000000
        self.model = "openai/gpt-4o-mini"
        self.choices = [_StubChoice(message=_StubMessage(content=content))]
        self.usage = _StubUsage()
        self.system_fingerprint = "fp_stub"

    def model_dump(self):
        return {
            "id": self.id,
            "object": self.object,
            "created": self.created,
            "model": self.model,
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": self.choices[0].message.content,
                },
                "finish_reason": "stop",
            }],
            "usage": {
                "prompt_tokens": self.usage.prompt_tokens,
                "completion_tokens": self.usage.completion_tokens,
                "total_tokens": self.usage.total_tokens,
            },
        }


class _StubEmbeddingItem:
    def __init__(self, embedding=None, index=0):
        self.embedding = embedding if embedding is not None else [0.0] * 4
        self.index = index
        self.object = "embedding"


class _StubEmbeddingResponse:
    def __init__(self, n=1):
        self.object = "list"
        self.data = [_StubEmbeddingItem(index=i) for i in range(n)]
        self.model = "text-embedding-3-small"
        self.usage = _StubUsage(prompt=4, completion=0, total=4)


@pytest.fixture
def mock_collector() -> AsyncMock:
    collector = AsyncMock()
    collector.ingest_batch = AsyncMock(
        return_value={"accepted": 1, "rejected": 0, "deduplicated": 0, "total": 1}
    )
    return collector


@pytest.fixture
def pii_policy_auth(api_client: TestClient, mock_collector, monkeypatch):
    """Override auth + collector + per-tenant policy stub.

    The ``per-tenant policy stub`` lets each test set the resolved
    policy that ``_apply_pii_filter_to_messages`` would otherwise
    fetch from Postgres. Default mode is ``"redact"``; tests can
    override by calling ``set_policy(...)``.
    """
    from eden.api.app import app
    from eden.api.deps import get_ingestion_auth
    from eden.api.routes import gateway as gateway_module
    from eden.config import Settings, get_settings
    from eden.observability import telemetry_collector as tc_module
    from eden.data_platform.pii import PIIPolicy

    fake_auth = {
        "org_id": "org-pii",
        "user_id": None,
        "api_key_id": "key-1",
        "auth_method": "api_key",
    }
    app.dependency_overrides[get_ingestion_auth] = lambda: fake_auth

    async def _get():
        return mock_collector

    monkeypatch.setattr(tc_module, "get_telemetry_collector", _get)
    monkeypatch.setattr(gateway_module, "get_telemetry_collector", _get)
    monkeypatch.setattr(gateway_module, "_gateway", None)
    # F62 — the cache is now an OrderedDict so the cap /
    # FIFO eviction logic can call ``move_to_end`` /
    # ``popitem``. Use an OrderedDict() to match the
    # module's expected type.
    monkeypatch.setattr(
        gateway_module,
        "_upstream_client_cache",
        OrderedDict(),
    )

    blank = Settings(
        openrouter_api_key="",
        openrouter_base_url="https://openrouter.ai/api/v1",
        minimax_api_key="",
        minimax_base_url="https://api.openai.com/v1",
        use_minimax=False,
    )
    monkeypatch.setattr(gateway_module, "_settings", lambda: blank)
    monkeypatch.setattr("eden.config.get_settings", lambda: blank)

    # Replace the per-tenant policy resolver with a sync shim that
    # returns the policy that ``monkeypatch`` set via ``set_policy``.
    policy_holder: dict[str, PIIPolicy | None] = {"policy": None}

    def _set_policy(p: PIIPolicy | None) -> None:
        policy_holder["policy"] = p

    async def _stub_resolver(org_id: str | None):
        return policy_holder["policy"] or PIIPolicy()

    monkeypatch.setattr(
        "eden.llmops.policy_cache.get_policy_for_tenant",
        _stub_resolver,
    )

    async def _create(**kwargs):
        return _StubChatResponse(content="ok")

    monkeypatch.setattr(
        gateway_module.AsyncOpenAI, "chat",
        MagicMock(completions=MagicMock(create=AsyncMock(side_effect=_create))),
        raising=False,
    )

    try:
        yield {"auth": fake_auth, "set_policy": _set_policy}
    finally:
        app.dependency_overrides.pop(get_ingestion_auth, None)
        get_settings.cache_clear()


# ── mode = "off" (system designed to use the PII) ───────────────────


class TestPolicyOffMode:
    def test_mode_off_skips_redaction(
        self, api_client: TestClient, pii_policy_auth, mock_collector
    ):
        from eden.data_platform.pii import PIIPolicy

        pii_policy_auth["set_policy"](PIIPolicy(mode="off"))

        seen_messages: list[Any] = []

        async def _create(**kwargs):
            seen_messages.append(kwargs.get("messages"))
            return _StubChatResponse(content="ok")

        from eden.api.routes import gateway as gateway_module
        gateway_module.AsyncOpenAI.chat.completions.create = AsyncMock(
            side_effect=_create,
        )

        r = api_client.post(
            "/gateway/v1/chat/completions",
            json={
                "model": "gpt-4o-mini",
                "messages": [{
                    "role": "user",
                    "content": "Email me at alice@example.com",
                }],
            },
        )
        assert r.status_code == 200, r.text
        # The raw email reaches the upstream untouched.
        assert seen_messages[0][0]["content"] == "Email me at alice@example.com"
        # Telemetry records the bypass.
        event = mock_collector.ingest_batch.await_args[0][0][0]
        findings = event.payload.get("pii_findings") or []
        assert "pii_bypassed:mode_off" in findings

    def test_mode_redact_default_still_masks(
        self, api_client: TestClient, pii_policy_auth
    ):
        """Default policy (no row in DB) should still mask."""
        # No set_policy call — resolver returns PIIPolicy() default.

        seen_messages: list[Any] = []

        async def _create(**kwargs):
            seen_messages.append(kwargs.get("messages"))
            return _StubChatResponse(content="ok")

        from eden.api.routes import gateway as gateway_module
        gateway_module.AsyncOpenAI.chat.completions.create = AsyncMock(
            side_effect=_create,
        )

        r = api_client.post(
            "/gateway/v1/chat/completions",
            json={
                "model": "gpt-4o-mini",
                "messages": [{
                    "role": "user",
                    "content": "Email alice@example.com",
                }],
            },
        )
        assert r.status_code == 200, r.text
        text = seen_messages[0][0]["content"]
        assert "alice@example.com" not in text


# ── Per-request opt-out ─────────────────────────────────────────────


class TestPerRequestBypass:
    def test_x_pii_bypass_header_skips_redaction(
        self, api_client: TestClient, pii_policy_auth
    ):
        """``X-PII-Bypass: true`` lets the caller override the tenant
        policy for one request — the system is designed to use the
        PII for this specific call."""

        seen_messages: list[Any] = []

        async def _create(**kwargs):
            seen_messages.append(kwargs.get("messages"))
            return _StubChatResponse(content="ok")

        from eden.api.routes import gateway as gateway_module
        gateway_module.AsyncOpenAI.chat.completions.create = AsyncMock(
            side_effect=_create,
        )

        r = api_client.post(
            "/gateway/v1/chat/completions",
            json={
                "model": "gpt-4o-mini",
                "messages": [{
                    "role": "user",
                    "content": "Email alice@example.com",
                }],
            },
            headers={"X-PII-Bypass": "true"},
        )
        assert r.status_code == 200, r.text
        assert seen_messages[0][0]["content"] == "Email alice@example.com"

    def test_body_pii_filter_enabled_false_skips_redaction(
        self, api_client: TestClient, pii_policy_auth
    ):
        """The body field is the OpenAI-compatible equivalent of the
        header — useful for clients that can't easily add custom
        headers."""

        seen_messages: list[Any] = []

        async def _create(**kwargs):
            seen_messages.append(kwargs.get("messages"))
            return _StubChatResponse(content="ok")

        from eden.api.routes import gateway as gateway_module
        gateway_module.AsyncOpenAI.chat.completions.create = AsyncMock(
            side_effect=_create,
        )

        r = api_client.post(
            "/gateway/v1/chat/completions",
            json={
                "model": "gpt-4o-mini",
                "pii_filter_enabled": False,
                "messages": [{
                    "role": "user",
                    "content": "Email alice@example.com",
                }],
            },
        )
        assert r.status_code == 200, r.text
        assert seen_messages[0][0]["content"] == "Email alice@example.com"

    def test_truthy_header_values_recognised(
        self, api_client: TestClient, pii_policy_auth
    ):
        """``1``, ``yes``, ``on`` all count as truthy."""
        for value in ("1", "yes", "on", "TRUE", "True"):
            seen_messages: list[Any] = []

            async def _create(**kwargs):
                seen_messages.append(kwargs.get("messages"))
                return _StubChatResponse(content="ok")

            from eden.api.routes import gateway as gateway_module
            gateway_module.AsyncOpenAI.chat.completions.create = AsyncMock(
                side_effect=_create,
            )

            r = api_client.post(
                "/gateway/v1/chat/completions",
                json={
                    "model": "gpt-4o-mini",
                    "messages": [{
                        "role": "user",
                        "content": "Email alice@example.com",
                    }],
                },
                headers={"X-PII-Bypass": value},
            )
            assert r.status_code == 200, f"{r.text} (header value: {value!r})"
            assert "alice@example.com" in seen_messages[0][0]["content"], value


# ── Fail-closed ──────────────────────────────────────────────────────


class TestFailClosed:
    def test_credential_in_request_returns_422(
        self, api_client: TestClient, pii_policy_auth, mock_collector
    ):
        """When the tenant policy is ``mode="fail_closed"`` and a
        credential is detected, the gateway returns 422 instead of
        silently masking the prompt."""
        from eden.data_platform.pii import PIIPolicy

        pii_policy_auth["set_policy"](PIIPolicy(mode="fail_closed"))

        from eden.api.routes import gateway as gateway_module

        async def _create(**kwargs):
            return _StubChatResponse(content="ok")

        gateway_module.AsyncOpenAI.chat.completions.create = AsyncMock(
            side_effect=_create,
        )

        r = api_client.post(
            "/gateway/v1/chat/completions",
            json={
                "model": "gpt-4o-mini",
                "messages": [{
                    "role": "user",
                    "content": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature",
                }],
            },
        )
        assert r.status_code == 422, r.text
        body = r.json()
        assert body["detail"]["error"] == "pii_fail_closed"
        # Telemetry records the failure.
        assert mock_collector.ingest_batch.await_count == 1
        event = mock_collector.ingest_batch.await_args[0][0][0]
        assert event.outcome == "failure"
        assert event.payload.get("error_type") == "pii_fail_closed"

    def test_non_credential_pii_does_not_fail_closed(
        self, api_client: TestClient, pii_policy_auth
    ):
        """Fail-closed only triggers on credential categories; an
        email (non-credential) is still masked, not rejected."""
        from eden.data_platform.pii import PIIPolicy

        pii_policy_auth["set_policy"](PIIPolicy(mode="fail_closed"))

        seen_messages: list[Any] = []

        async def _create(**kwargs):
            seen_messages.append(kwargs.get("messages"))
            return _StubChatResponse(content="ok")

        from eden.api.routes import gateway as gateway_module
        gateway_module.AsyncOpenAI.chat.completions.create = AsyncMock(
            side_effect=_create,
        )

        r = api_client.post(
            "/gateway/v1/chat/completions",
            json={
                "model": "gpt-4o-mini",
                "messages": [{
                    "role": "user",
                    "content": "Email alice@example.com",
                }],
            },
        )
        assert r.status_code == 200, r.text
        assert "alice@example.com" not in seen_messages[0][0]["content"]

    def test_per_request_bypass_denied_under_fail_closed(
        self, api_client: TestClient, pii_policy_auth
    ):
        """Client bypass must not override tenant fail-closed."""
        from eden.data_platform.pii import PIIPolicy

        pii_policy_auth["set_policy"](PIIPolicy(mode="fail_closed"))

        seen_messages: list[Any] = []

        async def _create(**kwargs):
            seen_messages.append(kwargs.get("messages"))
            return _StubChatResponse(content="ok")

        from eden.api.routes import gateway as gateway_module
        gateway_module.AsyncOpenAI.chat.completions.create = AsyncMock(
            side_effect=_create,
        )

        r = api_client.post(
            "/gateway/v1/chat/completions",
            json={
                "model": "gpt-4o-mini",
                "messages": [{
                    "role": "user",
                    "content": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature",
                }],
            },
            headers={"X-PII-Bypass": "true"},
        )
        # Fail-closed: credential aborts (422) — bypass ignored.
        assert r.status_code == 422, r.text
        assert r.json()["detail"]["error"] == "pii_fail_closed"
        assert not seen_messages

    def test_x_pii_mode_off_denied_under_fail_closed(
        self, api_client: TestClient, pii_policy_auth
    ):
        """Client ``X-PII-Mode: off`` must not disable PII under
        tenant fail-closed (same spirit as X-PII-Bypass deny)."""
        from eden.data_platform.pii import PIIPolicy

        pii_policy_auth["set_policy"](PIIPolicy(mode="fail_closed"))

        seen_messages: list[Any] = []

        async def _create(**kwargs):
            seen_messages.append(kwargs.get("messages"))
            return _StubChatResponse(content="ok")

        from eden.api.routes import gateway as gateway_module
        gateway_module.AsyncOpenAI.chat.completions.create = AsyncMock(
            side_effect=_create,
        )

        r = api_client.post(
            "/gateway/v1/chat/completions",
            json={
                "model": "gpt-4o-mini",
                "messages": [{
                    "role": "user",
                    "content": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature",
                }],
            },
            headers={"X-PII-Mode": "off"},
        )
        assert r.status_code == 422, r.text
        assert r.json()["detail"]["error"] == "pii_fail_closed"
        assert not seen_messages


# ── Per-tenant disabled categories ──────────────────────────────────


class TestDisabledCategories:
    def test_disabled_category_not_redacted(
        self, api_client: TestClient, pii_policy_auth
    ):
        """A tenant that runs an internal-secret-management flow
        may set ``disabled_categories=["api_key"]`` so URLs with
        embedded credentials pass through unmasked."""
        from eden.data_platform.pii import PIIPolicy

        pii_policy_auth["set_policy"](
            PIIPolicy(
                mode="redact",
                disabled_categories={"api_key"},
            ),
        )

        seen_messages: list[Any] = []

        async def _create(**kwargs):
            seen_messages.append(kwargs.get("messages"))
            return _StubChatResponse(content="ok")

        from eden.api.routes import gateway as gateway_module
        gateway_module.AsyncOpenAI.chat.completions.create = AsyncMock(
            side_effect=_create,
        )

        r = api_client.post(
            "/gateway/v1/chat/completions",
            json={
                "model": "gpt-4o-mini",
                "messages": [{
                    "role": "user",
                    "content": "Email alice@example.com and use sk_live_abc123def456ghi789jkl012mno",
                }],
            },
        )
        assert r.status_code == 200, r.text
        text = seen_messages[0][0]["content"]
        # Email IS redacted (default enabled).
        assert "alice@example.com" not in text
        # API key NOT redacted (tenant disabled the category).
        assert "sk_live_abc123def456ghi789jkl012mno" in text


# ── Static default list ──────────────────────────────────────────────


class TestDefaultCategories:
    def test_default_categories_include_all_june_2026_set(self):
        """The static default list returned by the GET handler must
        include the June 2026 hardened categories — otherwise the
        gateway / ingest layer silently misses credentials that
        the source-of-truth regex set would catch."""
        from eden.data_platform.pii import _DEFAULT_CATEGORIES
        from eden.api.routes.pii_policy import PIIPolicyOut

        # Just construct the default response (no row in DB) and
        # check the categories include the June 2026 additions.
        from eden.api.routes.pii_policy import _DEFAULT_CATEGORIES as _ROUTE_DEFAULT
        # The route now imports from pii.py — they should be the
        # same object.
        assert list(_ROUTE_DEFAULT) == list(_DEFAULT_CATEGORIES)
        # All categories should be present.
        for required in ("aws_secret", "private_key", "iban", "passport"):
            assert required in _DEFAULT_CATEGORIES, (
                f"missing required default category: {required}"
            )


# ── Per-request mode override ───────────────────────────────────────


class TestPerRequestModeOverride:
    """The ``X-PII-Mode`` header (and the equivalent body field)
    lets a single call change the redaction mode without touching
    the tenant policy."""

    def test_x_pii_mode_fail_closed_triggers_422_on_credential(
        self, api_client: TestClient, pii_policy_auth
    ):
        """Even when the tenant policy is mode=redact (the default),
        a single request with ``X-PII-Mode: fail_closed`` flips the
        resolution to fail-closed and 422s on a credential."""

        from eden.api.routes import gateway as gateway_module
        gateway_module.AsyncOpenAI.chat.completions.create = AsyncMock(
            return_value=_StubChatResponse(content="ok"),
        )

        # The credential is in a structured message; the request
        # carries a fake AWS-shaped secret so the regex pattern
        # matches. We use a clearly-fake key so we don't ship a
        # real one to a test stub.
        fake_secret = "AKIAIOSFODNN7EXAMPLE"

        r = api_client.post(
            "/gateway/v1/chat/completions",
            json={
                "model": "gpt-4o-mini",
                "messages": [{
                    "role": "user",
                    "content": f"Here's a key: {fake_secret}",
                }],
            },
            headers={"X-PII-Mode": "fail_closed"},
        )
        assert r.status_code == 422, r.text
        body = r.json()
        assert body["detail"]["error"] == "pii_fail_closed"

    def test_x_pii_mode_off_overrides_tenant_policy(
        self, api_client: TestClient, pii_policy_auth
    ):
        """Tenant policy is mode=redact (default), but the per-call
        ``X-PII-Mode: off`` header flips it to off — the system is
        designed to use the PII for this specific call."""

        seen_messages: list[Any] = []

        async def _create(**kwargs):
            seen_messages.append(kwargs.get("messages"))
            return _StubChatResponse(content="ok")

        from eden.api.routes import gateway as gateway_module
        gateway_module.AsyncOpenAI.chat.completions.create = AsyncMock(
            side_effect=_create,
        )

        r = api_client.post(
            "/gateway/v1/chat/completions",
            json={
                "model": "gpt-4o-mini",
                "messages": [{
                    "role": "user",
                    "content": "Email alice@example.com",
                }],
            },
            headers={"X-PII-Mode": "off"},
        )
        assert r.status_code == 200, r.text
        # Mode off ⇒ no redaction ⇒ raw email survives.
        assert seen_messages[0][0]["content"] == "Email alice@example.com"

    def test_body_pii_mode_field_works_like_header(
        self, api_client: TestClient, pii_policy_auth
    ):
        """OpenAI-compatible clients that prefer body fields over
        custom headers should still get the same behaviour."""

        seen_messages: list[Any] = []

        async def _create(**kwargs):
            seen_messages.append(kwargs.get("messages"))
            return _StubChatResponse(content="ok")

        from eden.api.routes import gateway as gateway_module
        gateway_module.AsyncOpenAI.chat.completions.create = AsyncMock(
            side_effect=_create,
        )

        r = api_client.post(
            "/gateway/v1/chat/completions",
            json={
                "model": "gpt-4o-mini",
                "pii_mode": "off",
                "messages": [{
                    "role": "user",
                    "content": "Email alice@example.com",
                }],
            },
        )
        assert r.status_code == 200, r.text
        assert seen_messages[0][0]["content"] == "Email alice@example.com"


# ── Per-request disabled-categories override ────────────────────────


class TestPerRequestDisabledCategories:
    """The ``X-PII-Disabled-Categories`` header lets a single call
    drop specific categories from the active set, layered on top of
    the tenant policy."""

    def test_x_pii_disabled_categories_keeps_email_active(
        self, api_client: TestClient, pii_policy_auth
    ):
        """Disabling the api_key category does NOT also disable
        email — the active set is the tenant set minus the named
        categories."""

        seen_messages: list[Any] = []

        async def _create(**kwargs):
            seen_messages.append(kwargs.get("messages"))
            return _StubChatResponse(content="ok")

        from eden.api.routes import gateway as gateway_module
        gateway_module.AsyncOpenAI.chat.completions.create = AsyncMock(
            side_effect=_create,
        )

        r = api_client.post(
            "/gateway/v1/chat/completions",
            json={
                "model": "gpt-4o-mini",
                "messages": [{
                    "role": "user",
                    "content": "Email alice@example.com",
                }],
            },
            headers={"X-PII-Disabled-Categories": "api_key,jwt"},
        )
        assert r.status_code == 200, r.text
        # Email still gets redacted because only api_key + jwt were
        # disabled.
        assert "alice@example.com" not in seen_messages[0][0]["content"]

    def test_x_pii_disabled_categories_drops_email(
        self, api_client: TestClient, pii_policy_auth
    ):
        """When the caller drops the email category, the email
        pattern is no longer in the active set and passes through."""

        seen_messages: list[Any] = []

        async def _create(**kwargs):
            seen_messages.append(kwargs.get("messages"))
            return _StubChatResponse(content="ok")

        from eden.api.routes import gateway as gateway_module
        gateway_module.AsyncOpenAI.chat.completions.create = AsyncMock(
            side_effect=_create,
        )

        r = api_client.post(
            "/gateway/v1/chat/completions",
            json={
                "model": "gpt-4o-mini",
                "messages": [{
                    "role": "user",
                    "content": "Email alice@example.com",
                }],
            },
            headers={"X-PII-Disabled-Categories": "email,phone"},
        )
        assert r.status_code == 200, r.text
        assert seen_messages[0][0]["content"] == "Email alice@example.com"

    def test_body_pii_disabled_categories_field_works_like_header(
        self, api_client: TestClient, pii_policy_auth
    ):
        """Body field version of the disabled-categories override,
        for OpenAI-compatible clients that can't easily add custom
        headers."""

        seen_messages: list[Any] = []

        async def _create(**kwargs):
            seen_messages.append(kwargs.get("messages"))
            return _StubChatResponse(content="ok")

        from eden.api.routes import gateway as gateway_module
        gateway_module.AsyncOpenAI.chat.completions.create = AsyncMock(
            side_effect=_create,
        )

        r = api_client.post(
            "/gateway/v1/chat/completions",
            json={
                "model": "gpt-4o-mini",
                "pii_disabled_categories": ["email"],
                "messages": [{
                    "role": "user",
                    "content": "Email alice@example.com",
                }],
            },
        )
        assert r.status_code == 200, r.text
        assert seen_messages[0][0]["content"] == "Email alice@example.com"


# ── /completions + /embeddings parity ────────────────────────────────


class TestLegacyCompletionsPIIHeaders:
    """The legacy ``/v1/completions`` endpoint must honour the same
    headers and body fields as ``/v1/chat/completions`` — bypass,
    mode override, disabled categories, and fail-closed → 422."""

    def test_bypass_header_skips_redaction(
        self, api_client: TestClient, pii_policy_auth
    ):
        seen_prompts: list[Any] = []

        async def _create(**kwargs):
            seen_prompts.append(kwargs.get("prompt"))
            return _StubChatResponse(content="ok")

        from eden.api.routes import gateway as gateway_module
        # The completions endpoint uses ``client.completions.create``.
        gateway_module.AsyncOpenAI.completions = MagicMock(
            create=AsyncMock(side_effect=_create),
        )

        r = api_client.post(
            "/gateway/v1/completions",
            json={
                "model": "gpt-4o-mini",
                "prompt": "Email alice@example.com",
            },
            headers={"X-PII-Bypass": "true"},
        )
        assert r.status_code == 200, r.text
        assert seen_prompts[0] == "Email alice@example.com"

    def test_fail_closed_returns_422_on_credential(
        self, api_client: TestClient, pii_policy_auth
    ):
        from eden.api.routes import gateway as gateway_module
        gateway_module.AsyncOpenAI.completions = MagicMock(
            create=AsyncMock(return_value=_StubChatResponse(content="ok")),
        )

        fake_secret = "AKIAIOSFODNN7EXAMPLE"

        r = api_client.post(
            "/gateway/v1/completions",
            json={
                "model": "gpt-4o-mini",
                "prompt": f"key={fake_secret}",
            },
            headers={"X-PII-Mode": "fail_closed"},
        )
        assert r.status_code == 422, r.text
        assert r.json()["detail"]["error"] == "pii_fail_closed"

    def test_mode_off_passes_raw_pii_through(
        self, api_client: TestClient, pii_policy_auth
    ):
        seen_prompts: list[Any] = []

        async def _create(**kwargs):
            seen_prompts.append(kwargs.get("prompt"))
            return _StubChatResponse(content="ok")

        from eden.api.routes import gateway as gateway_module
        gateway_module.AsyncOpenAI.completions = MagicMock(
            create=AsyncMock(side_effect=_create),
        )

        r = api_client.post(
            "/gateway/v1/completions",
            json={
                "model": "gpt-4o-mini",
                "prompt": "Email alice@example.com",
            },
            headers={"X-PII-Mode": "off"},
        )
        assert r.status_code == 200, r.text
        assert seen_prompts[0] == "Email alice@example.com"


class TestEmbeddingsPIIHeaders:
    """``/v1/embeddings`` honours the same PII headers as the chat
    and completions paths."""

    def test_bypass_header_skips_redaction(
        self, api_client: TestClient, pii_policy_auth
    ):
        seen_inputs: list[Any] = []

        async def _create(**kwargs):
            seen_inputs.append(kwargs.get("input"))
            return _StubEmbeddingResponse()

        from eden.api.routes import gateway as gateway_module
        gateway_module.AsyncOpenAI.embeddings = MagicMock(
            create=AsyncMock(side_effect=_create),
        )

        r = api_client.post(
            "/gateway/v1/embeddings",
            json={
                "model": "text-embedding-3-small",
                "input": "Email alice@example.com",
            },
            headers={"X-PII-Bypass": "true"},
        )
        assert r.status_code == 200, r.text
        assert seen_inputs[0] == "Email alice@example.com"

    def test_fail_closed_returns_422_on_credential(
        self, api_client: TestClient, pii_policy_auth
    ):
        from eden.api.routes import gateway as gateway_module
        gateway_module.AsyncOpenAI.embeddings = MagicMock(
            create=AsyncMock(return_value=_StubEmbeddingResponse()),
        )

        fake_secret = "AKIAIOSFODNN7EXAMPLE"

        r = api_client.post(
            "/gateway/v1/embeddings",
            json={
                "model": "text-embedding-3-small",
                "input": f"key={fake_secret}",
            },
            headers={"X-PII-Mode": "fail_closed"},
        )
        assert r.status_code == 422, r.text
        assert r.json()["detail"]["error"] == "pii_fail_closed"
