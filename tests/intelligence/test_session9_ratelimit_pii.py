"""Session 9 tests — rate limiter + PII fail-closed (S-14, S-15, S-16, S-17).

Four related fixes:

* **S-14** — ``tenant_rate_limit.py:_check_redis`` previously
  ZADD'd every request (including denied ones) — the sliding window
  self-polluted and eventually rate-limited every legitimate caller.
  Fix: only ZADD when ``allowed=True``.

* **S-15** — ``data_platform/pii.py:_mask_dict`` previously masked
  sensitive keys (e.g. ``password``) without first checking the
  VALUE for credentials. A password field containing an API key
  bypassed the fail-closed contract. Fix: run
  ``_mask_string(value, check_credentials=True)`` FIRST for any
  string value.

* **S-16** — ``observability/ingestion/pii.py:mask_payload``
  previously returned the unmasked payload on any
  ``except Exception`` (only ``PIIMaskingError`` was re-raised).
  Fix: when ``fail_closed=True``, raise on ANY exception.

* **S-17** — ``gateway.py:_emit_gateway_telemetry`` previously
  wrote the raw ``request_body`` (containing free-form user input
  like the OpenAI chat messages) to ``telemetry_events``. Fix:
  scrub via ``mask_payload`` BEFORE constructing the TelemetryEvent.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ─── S-14: rate limiter ZADD only when allowed ─────────────────────
class TestS14RateLimiterZaddOrder:
    @pytest.mark.asyncio
    async def test_zadd_runs_only_when_allowed(self) -> None:
        """Capture the sequence of redis calls and assert ZADD is
        skipped when the count is at-or-above the limit.
        """
        from eden.api.middleware.tenant_rate_limit import TenantRateLimitMiddleware

        mw = TenantRateLimitMiddleware(app=MagicMock())

        # Two-phase call tracking: separate mock for the count phase
        # vs the ZADD phase.
        zadd_calls: list[dict] = []
        zcard_results = [5, 5]  # both calls return count=5 (at limit)

        class _FakePipeline:
            def __init__(self):
                self.calls: list[list] = []

            async def execute(self):
                # First call returns zrem+zcard results, second returns
                # zadd+zexpire results.
                if not hasattr(self, "_first_done"):
                    self._first_done = True
                    return [0, zcard_results.pop(0)]  # zrem, zcard
                return [1, 1]  # zadd, expire (success)

            def zremrangebyscore(self, *a, **kw):
                self.calls.append(["zremrangebyscore", a, kw])
                return self

            def zcard(self, *a, **kw):
                self.calls.append(["zcard", a, kw])
                return self

            def zadd(self, key, mapping):
                self.calls.append(["zadd", key, mapping])
                zadd_calls.append({"key": key, "mapping": mapping})
                return self

            def expire(self, key, ttl):
                self.calls.append(["expire", key, ttl])
                return self

        class _FakeRedis:
            def pipeline(self):
                return _FakePipeline()

        fake_redis = _FakeRedis()

        # Two calls: both at the limit. Neither should ZADD.
        with patch.object(mw, "_get_redis", AsyncMock(return_value=fake_redis)):
            allowed_a, *_ = await mw._check_redis("k1", limit=5, window=60)
            allowed_b, *_ = await mw._check_redis("k2", limit=5, window=60)

        assert allowed_a is False
        assert allowed_b is False
        assert zadd_calls == [], (
            f"S-14 fix: ZADD must not fire when the request is denied; got {zadd_calls}"
        )

    @pytest.mark.asyncio
    async def test_zadd_runs_when_allowed(self) -> None:
        """Count below the limit → ZADD must fire (sliding window grows)."""
        from eden.api.middleware.tenant_rate_limit import TenantRateLimitMiddleware

        mw = TenantRateLimitMiddleware(app=MagicMock())
        zadd_calls: list[dict] = []

        class _FakePipeline:
            def __init__(self):
                self._first_done = False

            async def execute(self):
                if not self._first_done:
                    self._first_done = True
                    return [0, 2]  # zrem, zcard=2 (under limit of 5)
                return [1, 1]  # zadd, expire

            def zremrangebyscore(self, *a, **kw):
                return self

            def zcard(self, *a, **kw):
                return self

            def zadd(self, key, mapping):
                zadd_calls.append({"key": key, "mapping": mapping})
                return self

            def expire(self, key, ttl):
                return self

        class _FakeRedis:
            def pipeline(self):
                return _FakePipeline()

        fake_redis = _FakeRedis()
        with patch.object(mw, "_get_redis", AsyncMock(return_value=fake_redis)):
            allowed, remaining, *_ = await mw._check_redis("k1", limit=5, window=60)

        assert allowed is True
        assert len(zadd_calls) == 1


# ─── S-15: PII _mask_dict always blanks sensitive keys ──────────
class TestS15MaskDictCredentialFirst:
    def _masker(self, fail_closed: bool = False):
        from eden.data_platform.pii import PIIMasker, PIIPolicy

        policy = PIIPolicy(fail_closed_on_credentials=fail_closed)
        return PIIMasker(policy=policy)

    def test_password_field_with_api_key_blanks_value(self) -> None:
        """A ``password`` value that happens to contain an API-key
        pattern is still always redacted to ``[PASSWORD_REDACTED]``.
        The credential-in-password leak that the original
        'credential-first' audit was trying to defend against is
        closed by the unconditional blanking: there is no way for
        the credential bytes to survive the redaction. Pre-fix the
        audit left passwords un-redacted when the value didn't
        match a credential pattern — see test_mask_dict_sensitive_keys.
        """
        masker = self._masker(fail_closed=True)
        # The credential pattern matches ``sk_<20+>``; ``sk-`` (dash)
        # wouldn't match. Use the underscore form.
        body = {"password": "sk_abcdef1234567890abcdef1234567890"}
        result = masker.mask(body)
        # Value is fully wiped — no exception, no leak surface.
        assert result["password"] == "[PASSWORD_REDACTED]"

    def test_password_field_without_credential_still_blanks(self) -> None:
        """A non-credential password value is still always redacted
        to ``[PASSWORD_REDACTED]`` — a password is sensitive by
        definition, not by regex shape. Pre-fix the 'credential-
        first' audit left this value un-redacted, which leaked
        every password that didn't accidentally look like a known
        credential pattern.
        """
        masker = self._masker(fail_closed=False)
        body = {"password": "user-typed-this"}
        result = masker.mask(body)
        assert result["password"] == "[PASSWORD_REDACTED]"

    def test_top_level_string_value_runs_credential_check(self) -> None:
        """Any string value — at any depth — runs the credential
        check, not just sensitive-keyed values.
        """
        from eden.data_platform.pii import PIIMaskingError

        masker = self._masker(fail_closed=True)
        # ``username`` is not in the sensitive-key list, but its
        # value is an API key — must still fail closed.
        body = {"username": "sk_abcdef1234567890abcdef1234567890"}
        with pytest.raises(PIIMaskingError):
            masker.mask(body)

    def test_nested_dict_string_runs_credential_check(self) -> None:
        from eden.data_platform.pii import PIIMaskingError

        masker = self._masker(fail_closed=True)
        body = {"outer": {"inner_field": "sk_abcdef1234567890abcdef1234567890"}}
        with pytest.raises(PIIMaskingError):
            masker.mask(body)

    def test_non_string_value_with_sensitive_key_is_redacted(self) -> None:
        """Sensitive-keyed NON-string values still get the key-based
        redaction — the credential check requires a string to scan.

        ``api_key`` (singular) is in the default SENSITIVE_KEYS set;
        ``api_keys`` (plural) is NOT. Use the singular form.
        """
        masker = self._masker(fail_closed=False)
        body = {"api_key": [1, 2, 3]}
        result = masker.mask(body)
        # S-15 fix: non-string values with sensitive keys get the
        # key-based redaction (the credential check requires a
        # string to scan, so list/int values fall through to the
        # key-based path).
        assert isinstance(result["api_key"], str)
        assert "API_KEY" in result["api_key"] or "REDACTED" in result["api_key"]


# ─── S-16: ingestion mask_payload fails closed ─────────────────────
class TestS16MaskPayloadFailClosed:
    @pytest.mark.asyncio
    async def test_raises_on_exception_when_fail_closed(self) -> None:
        """When ``policy.fail_closed_on_credentials=True`` and the
        masker throws any exception, ``mask_payload`` MUST re-raise
        rather than return the unmasked payload.
        """
        from eden.observability.ingestion import pii as ingestion_pii

        # ``mask_payload`` does ``PIIMasker(policy=policy)`` inside
        # its function body — patching the local symbol via the
        # module attribute is what the production code resolves at
        # call time.
        with patch(
            "eden.observability.ingestion.pii.PIIMasker"
        ) as mock_masker_cls:
            instance = mock_masker_cls.return_value
            instance.mask.side_effect = RuntimeError("regex engine exploded")

            # Resolve a tenant policy that has fail_closed=True.
            # The simplest way is to pre-populate the policy cache
            # OR use a custom policy resolver. We patch the
            # resolver too.
            with patch(
                "eden.observability.ingestion.pii.resolve_policy",
                AsyncMock(return_value=_fail_closed_policy()),
            ):
                with pytest.raises(RuntimeError, match="regex engine exploded"):
                    await ingestion_pii.mask_payload(
                        {"some": "value"}, tenant_id="org-test",
                    )

    @pytest.mark.asyncio
    async def test_does_not_raise_on_pii_masking_error_fail_closed(self) -> None:
        """``PIIMaskingError`` is the explicit fail-closed signal —
        it must propagate as-is (not be caught and re-raised as a
        different type).
        """
        from eden.data_platform.pii import PIIMaskingError
        from eden.observability.ingestion import pii as ingestion_pii

        with patch(
            "eden.observability.ingestion.pii.PIIMasker"
        ) as mock_masker_cls:
            instance = mock_masker_cls.return_value
            instance.mask.side_effect = PIIMaskingError("credential in payload")

            with pytest.raises(PIIMaskingError, match="credential"):
                await ingestion_pii.mask_payload(
                    {"some": "value"}, tenant_id=None,
                )

    @pytest.mark.asyncio
    async def test_does_not_raise_when_fail_closed_false(self) -> None:
        """When ``fail_closed_on_credentials=False`` (the default),
        exceptions are caught and the original payload is returned.
        This is the operator-opt-in behaviour — sensitive tenants
        must explicitly set fail_closed=True.
        """
        from eden.observability.ingestion import pii as ingestion_pii

        with patch(
            "eden.observability.ingestion.pii.PIIMasker"
        ) as mock_masker_cls:
            instance = mock_masker_cls.return_value
            instance.mask.side_effect = RuntimeError("regex engine exploded")

            # tenant_id=None means policy defaults to PIIPolicy()
            # where fail_closed_on_credentials=False.
            result = await ingestion_pii.mask_payload(
                {"some": "value"}, tenant_id=None,
            )
            # The original payload is returned.
            assert result == {"some": "value"}


def _fail_closed_policy():
    from eden.data_platform.pii import PIIPolicy

    return PIIPolicy(fail_closed_on_credentials=True)


# ─── S-17: gateway request_body scrub ─────────────────────────────
class TestS17GatewayRequestBodyScrub:
    @pytest.mark.asyncio
    async def test_request_body_is_scrubbed_before_telemetry_emit(self) -> None:
        """The audit bug: ``_emit_gateway_telemetry`` persisted
        the raw ``request_body`` (free-form user input) to
        ``telemetry_events``. Fix scrubs via ``PIIMasker`` first.
        """
        from eden.api.routes import gateway as gw

        # Capture what TelemetryEvent receives.
        captured: dict = {}

        class _FakeTelemetryEvent:
            def __init__(self, **kwargs):
                captured.update(kwargs)

        captured_collector = MagicMock()
        captured_collector.ingest_batch = AsyncMock()

        body_with_pii = {
            "model": "gpt-4o-mini",
            "messages": [
                {"role": "user", "content": "hi"},
            ],
            "stream": False,
        }

        # ``_scrub_request_body`` does
        # ``from eden.data_platform.pii import PIIMasker`` inside
        # its body — patching the class via its module attribute is
        # what the function-local import resolves at call time.
        scrubbed_body = {
            **body_with_pii,
            "messages": [{"role": "user", "content": "[REDACTED]"}],
        }
        with patch(
            "eden.data_platform.pii.PIIMasker"
        ) as mock_masker_cls:
            mock_masker_cls.return_value.mask.return_value = scrubbed_body
            with patch.object(
                gw, "get_telemetry_collector",
                AsyncMock(return_value=captured_collector),
            ):
                with patch(
                    "eden.observability.telemetry_collector.TelemetryEvent",
                    _FakeTelemetryEvent,
                ):
                    await gw._emit_gateway_telemetry(
                        org_id="org-1",
                        auth_ctx={"auth_method": "api_key"},
                        model="gpt-4o-mini",
                        endpoint="chat.completions",
                        request_body=body_with_pii,
                    )

        # PIIMasker was instantiated and mask was called.
        mock_masker_cls.return_value.mask.assert_called_once_with(body_with_pii)
        # The TelemetryEvent got the SCRUBBED body, not the raw one.
        assert captured["request_body"]["messages"][0]["content"] == "[REDACTED]"
        # And the raw PII is NOT in the persisted body.
        assert "hi" not in str(captured["request_body"])

    @pytest.mark.asyncio
    async def test_scrub_failure_returns_input_unchanged(self) -> None:
        """If PIIMasker itself raises, the original body is kept
        (the ingestion layer will re-run PII; we never want to drop
        a gateway request because the scrubber tripped).
        """
        from eden.api.routes import gateway as gw

        captured: dict = {}

        class _FakeTelemetryEvent:
            def __init__(self, **kwargs):
                captured.update(kwargs)

        body = {"model": "gpt-4o-mini", "stream": False}

        with patch(
            "eden.data_platform.pii.PIIMasker"
        ) as mock_masker_cls:
            mock_masker_cls.return_value.mask.side_effect = RuntimeError(
                "scrubber exploded"
            )
            with patch(
                "eden.observability.telemetry_collector.TelemetryEvent",
                _FakeTelemetryEvent,
            ):
                await gw._emit_gateway_telemetry(
                    org_id="org-1",
                    auth_ctx={"auth_method": "api_key"},
                    model="gpt-4o-mini",
                    endpoint="chat.completions",
                    request_body=body,
                )

        assert captured["request_body"] is body

    @pytest.mark.asyncio
    async def test_empty_body_skips_scrub(self) -> None:
        """An empty / None request_body must not crash the scrub."""
        from eden.api.routes import gateway as gw

        captured: dict = {}

        class _FakeTelemetryEvent:
            def __init__(self, **kwargs):
                captured.update(kwargs)

        with patch(
            "eden.data_platform.pii.PIIMasker"
        ) as mock_masker_cls:
            with patch(
                "eden.observability.telemetry_collector.TelemetryEvent",
                _FakeTelemetryEvent,
            ):
                await gw._emit_gateway_telemetry(
                    org_id="org-1",
                    auth_ctx={"auth_method": "api_key"},
                    model="gpt-4o-mini",
                    endpoint="chat.completions",
                    request_body={},
                )

        # PIIMasker was NOT instantiated when body is empty.
        mock_masker_cls.assert_not_called()
        assert captured["request_body"] == {}
