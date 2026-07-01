"""Session 10 tests — GDPR RTBF auto-invoke + auth hashing + webhook SSRF.

Three audit items:

* **S-18** — ``llmops/promotion_hooks.py:on_compliance_gap_gdpr`` was
  advisory-only; the operator had to invoke ``RightToBeForgottenService``
  manually. Fix: when ``details`` carries a ``target_user_id`` (or
  ``subject_id``), auto-fire the redaction in best-effort mode.

* **S-19** — ``api/utils/auth.py`` previously used
  ``password.encode("utf-8")[:72]`` for bcrypt input, which could split
  a multi-byte UTF-8 character and cause two distinct passwords to
  collide on their first 72 bytes. Fix: SHA-256 pre-hash + zero-pad
  to 72 bytes.

* **S-20** — ``api/routes/webhooks.py:_validate_webhook_url`` checked
  the IP at registration time only. A DNS rebinding attack could
  return a public IP at registration and a private IP by delivery
  time. Fix: ``webhook_delivery.py:_assert_public_ip`` re-resolves
  + re-validates AT DELIVERY TIME before the HTTP connect.
"""

from __future__ import annotations

import hashlib
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ─── S-18: GDPR auto-RTBF on compliance gap ─────────────────────
class TestS18GdprAutoRtbf:
    """The audit bug: the GDPR gap hook only recorded the
    recommendation; the operator had to invoke the RTBF service
    manually. The S-18 fix auto-fires ``process_request`` when
    ``details`` carries a target user id.
    """

    @pytest.mark.asyncio
    async def test_target_user_id_triggers_rtbf_process_request(self) -> None:
        from eden.llmops.promotion_hooks import get_promotion_hook

        hook = get_promotion_hook()

        with patch(
            "eden.services.governance_intel.gdpr.RightToBeForgottenService"
        ) as mock_rtbf_cls:
            mock_service = mock_rtbf_cls.return_value
            mock_service.process_request = AsyncMock(
                return_value={
                    "ok": True,
                    "data": {"request_id": "rtbf-abc123"},
                }
            )

            action_id = await hook.on_compliance_gap_gdpr(
                "org-1",
                finding_id="finding-gdpr-s10-1",  # unique vs E.1 suite (1h bus suppression)
                framework_control="Art.17",
                details={
                    "target_user_id": "user-42",
                    "data_categories": ["trace_content"],
                },
            )

        # Hook still returns a non-empty action id (the
        # recommendation was recorded).
        assert action_id is not None
        # The RTBF service was instantiated and process_request
        # was called with the target user.
        mock_rtbf_cls.assert_called_once_with()
        mock_service.process_request.assert_awaited_once()
        call_kwargs = mock_service.process_request.await_args.kwargs
        assert call_kwargs["user_id"] == "user-42"
        assert call_kwargs["requested_by"] == "auto:on_compliance_gap_gdpr"
        assert call_kwargs["dry_run"] is False

    @pytest.mark.asyncio
    async def test_subject_id_alias_triggers_rtbf(self) -> None:
        """Some callers use ``subject_id`` instead of
        ``target_user_id`` (matches the Cat 9 user-intel
        naming). The S-18 fix honours both keys.
        """
        from eden.llmops.promotion_hooks import get_promotion_hook

        hook = get_promotion_hook()

        with patch(
            "eden.services.governance_intel.gdpr.RightToBeForgottenService"
        ) as mock_rtbf_cls:
            mock_service = mock_rtbf_cls.return_value
            mock_service.process_request = AsyncMock(
                return_value={"ok": True, "data": {"request_id": "r"}}
            )

            await hook.on_compliance_gap_gdpr(
                "org-1",
                finding_id="f-2",
                framework_control="Art.17",
                details={"subject_id": "user-99"},
            )

        assert mock_service.process_request.await_count == 1
        assert mock_service.process_request.await_args.kwargs["user_id"] == "user-99"

    @pytest.mark.asyncio
    async def test_no_target_user_id_skips_rtbf(self) -> None:
        """When the finding doesn't identify a subject (e.g., a
        gap in policy controls rather than a specific user),
        the hook still records the recommendation but does
        NOT auto-fire the redaction (no user to forget).
        """
        from eden.llmops.promotion_hooks import get_promotion_hook

        hook = get_promotion_hook()

        with patch(
            "eden.services.governance_intel.gdpr.RightToBeForgottenService"
        ) as mock_rtbf_cls:
            mock_service = mock_rtbf_cls.return_value
            mock_service.process_request = AsyncMock()

            action_id = await hook.on_compliance_gap_gdpr(
                "org-1",
                finding_id="f-3",
                framework_control="Art.30",
                details={"data_categories": ["logs"]},  # no subject
            )

        assert action_id is not None
        mock_service.process_request.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_rtbf_failure_does_not_break_hook(self) -> None:
        """If ``process_request`` raises (DB down, schema
        missing, etc.) the hook MUST still return the
        recommendation. Fail-soft, not fail-closed — the
        hook is the action-RECORDING layer, not the
        side-effect gatekeeper.
        """
        from eden.llmops.promotion_hooks import get_promotion_hook

        hook = get_promotion_hook()

        with patch(
            "eden.services.governance_intel.gdpr.RightToBeForgottenService"
        ) as mock_rtbf_cls:
            mock_service = mock_rtbf_cls.return_value
            mock_service.process_request = AsyncMock(
                side_effect=RuntimeError("postgres unreachable")
            )

            # MUST NOT raise.
            action_id = await hook.on_compliance_gap_gdpr(
                "org-1",
                finding_id="f-4",
                framework_control="Art.17",
                details={"target_user_id": "user-x"},
            )

        assert action_id is not None


# ─── S-19: auth hashing — SHA-256 pre-hash + pad to 72 bytes ────
class TestS19AuthHashing:
    """The audit bug: bcrypt's 72-byte input cap was being
    honoured by ``password.encode("utf-8")[:72]``. Two distinct
    passwords sharing their first 72 bytes hashed to the same
    value, AND a multi-byte UTF-8 character could be split
    mid-codepoint producing invalid UTF-8 in the hash input.

    Fix: pre-hash to a 32-byte SHA-256 digest, zero-pad to 72.
    """

    def test_ascii_password_verifies(self) -> None:
        from eden.api.utils.auth import hash_password, verify_password

        h = hash_password("correct-horse-battery-staple")
        assert verify_password("correct-horse-battery-staple", h)
        assert not verify_password("wrong-password", h)

    def test_long_ascii_password_does_not_truncate(self) -> None:
        """A 200-char ASCII password. Pre-fix: ``[:72]`` would
        silently truncate. Post-fix: the full password hashes
        deterministically (every distinct string has its own
        SHA-256 → bcrypt output).
        """
        from eden.api.utils.auth import hash_password, verify_password

        long_a = "a" * 200
        long_b = "a" * 199 + "b"  # differs only at byte 200
        h_a = hash_password(long_a)
        h_b = hash_password(long_b)
        # Distinct passwords must produce distinct hashes.
        assert h_a != h_b
        # And each verifies only against itself.
        assert verify_password(long_a, h_a)
        assert verify_password(long_b, h_b)
        assert not verify_password(long_a, h_b)

    def test_non_ascii_password_unicode(self) -> None:
        """Pre-fix: a UTF-8 multi-byte char straddling byte 72
        could split mid-codepoint. Post-fix: the SHA-256
        pre-hash collapses any UTF-8 string to 32 deterministic
        bytes BEFORE bcrypt sees it — so unicode is safe.
        """
        from eden.api.utils.auth import hash_password, verify_password

        # 60 ASCII chars + 20 multibyte Chinese chars = well over 72 bytes
        pw = "a" * 60 + "密" * 20
        h = hash_password(pw)
        assert verify_password(pw, h)
        # Different unicode string → different hash.
        other = "a" * 60 + "密" * 19 + "钥"
        assert not verify_password(other, h)

    def test_pre_hash_produces_72_bytes(self) -> None:
        """The internal ``_pre_hash`` helper must return exactly
        72 bytes (bcrypt's max). The padding is zero bytes so
        it doesn't perturb the digest.
        """
        from eden.api.utils.auth import _pre_hash

        out = _pre_hash("any-password")
        assert isinstance(out, bytes)
        assert len(out) == 72
        # First 32 bytes = SHA-256 digest of the password.
        expected_digest = hashlib.sha256(b"any-password").digest()
        assert out[:32] == expected_digest
        # Remaining 40 bytes are zero-padding.
        assert out[32:] == b"\x00" * 40

    def test_pre_hash_is_deterministic(self) -> None:
        """Same password → same pre-hash (deterministic so
        verification works).
        """
        from eden.api.utils.auth import _pre_hash

        a = _pre_hash("test-password")
        b = _pre_hash("test-password")
        assert a == b

    def test_no_bare_72_truncation_in_source(self) -> None:
        """Static check: the pre-fix pattern
        ``password.encode("utf-8")[:72]`` must not appear in
        ``auth.py``. The S-19 fix replaced it with the
        ``_pre_hash`` SHA-256 path.
        """
        from pathlib import Path

        src = Path("src/eden/api/utils/auth.py").read_text()
        assert '[:72]' not in src, (
            "S-19 regression: bare 72-byte slice found in auth.py — "
            "use _pre_hash() instead"
        )


# ─── S-20: webhook delivery-time SSRF guard ────────────────────
class TestS20WebhookSsrf:
    """The audit bug: ``_validate_webhook_url`` checked the
    hostname ONCE at registration. A DNS rebinding attack could
    return a public IP at create-time and a private IP by
    delivery time, bypassing the guard.

    Fix: ``webhook_delivery._assert_public_ip`` re-resolves the
    hostname AT DELIVERY TIME and rejects if the resolved IP is
    not public. Delivery is aborted (status='failed', moved to
    DLQ) so a malicious URL never causes the actual ``http.post``.
    """

    def test_https_loopback_rejected(self) -> None:
        from eden.services.webhook_delivery import _assert_public_ip

        with pytest.raises(ValueError, match="non-public"):
            _assert_public_ip("https://127.0.0.1/hook")

    def test_https_rfc1918_rejected(self) -> None:
        from eden.services.webhook_delivery import _assert_public_ip

        with pytest.raises(ValueError, match="non-public"):
            _assert_public_ip("https://10.0.0.5/hook")

    def test_https_link_local_rejected(self) -> None:
        from eden.services.webhook_delivery import _assert_public_ip

        # 169.254.x.x is link-local (AWS metadata lives here).
        with pytest.raises(ValueError, match="non-public"):
            _assert_public_ip("https://169.254.169.254/latest/meta-data/")

    def test_http_scheme_rejected(self) -> None:
        """Only https is allowed; plain http is rejected even
        on a public IP.
        """
        from eden.services.webhook_delivery import _assert_public_ip

        with pytest.raises(ValueError, match="scheme"):
            _assert_public_ip("http://example.com/hook")

    def test_missing_hostname_rejected(self) -> None:
        from eden.services.webhook_delivery import _assert_public_ip

        with pytest.raises(ValueError, match="hostname"):
            _assert_public_ip("https:///path-only")

    def test_unresolvable_host_rejected(self) -> None:
        """A hostname that does not exist in DNS is rejected —
        no silent fallback.
        """
        from eden.services.webhook_delivery import _assert_public_ip

        with patch(
            "socket.getaddrinfo",
            side_effect=__import__("socket").gaierror("no such host"),
        ):
            with pytest.raises(ValueError, match="could not be resolved"):
                _assert_public_ip("https://does-not-exist.example/hook")

    def test_public_ip_literal_passes(self) -> None:
        """A literal public IP (8.8.8.8 = Google DNS) is
        accepted without DNS resolution.
        """
        from eden.services.webhook_delivery import _assert_public_ip

        # Should not raise.
        _assert_public_ip("https://8.8.8.8/hook")

    def test_public_hostname_via_dns_passes(self) -> None:
        """A hostname that resolves to a public IP passes.
        We mock the resolver to return a known-public IP.
        """
        from eden.services.webhook_delivery import _assert_public_ip

        with patch(
            "socket.getaddrinfo",
            return_value=[(2, 1, 6, "", ("8.8.8.8", 0))],
        ):
            # Should not raise.
            _assert_public_ip("https://example.com/hook")

    def test_private_hostname_via_dns_rejected(self) -> None:
        """DNS-resolved private IP is rejected even though the
        hostname looks public. This is the rebinding attack
        the S-20 fix targets.
        """
        from eden.services.webhook_delivery import _assert_public_ip

        with patch(
            "socket.getaddrinfo",
            return_value=[(2, 1, 6, "", ("192.168.1.5", 0))],
        ):
            with pytest.raises(ValueError, match="non-public"):
                _assert_public_ip("https://attacker.example/hook")

    @pytest.mark.asyncio
    async def test_attempt_delivery_aborts_when_ssrf_guard_fails(
        self, mock_postgres_client: MagicMock,
    ) -> None:
        """End-to-end: when ``_assert_public_ip`` raises (DNS
        rebinding detected at delivery time), ``_attempt_delivery``
        MUST mark the delivery ``failed`` + move it to the DLQ
        and MUST NOT issue the HTTP request.
        """
        from eden.services.webhook_delivery import WebhookDeliveryService

        service = WebhookDeliveryService()

        # Postgres returns a delivery row.
        mock_postgres_client.fetchrow = AsyncMock(
            return_value={
                "attempt_count": 0,
                "max_attempts": 7,
                "webhook_id": "wh-1",
            }
        )
        update_calls: list[tuple] = []
        execute_calls: list[tuple] = []

        async def _execute_capture(sql, *args):
            execute_calls.append((sql, args))
            # UPDATE webhook_deliveries SET status='failed' is the
            # one we want to verify. Capture structured args.
            return None

        def _execute_sync_capture(sql, *args):
            execute_calls.append((sql, args))
            return None

        mock_postgres_client.execute = AsyncMock(side_effect=_execute_capture)
        mock_postgres_client.fetch = AsyncMock(return_value=[])

        # Move-to-DLQ must be a no-op for this test.
        service._move_to_dlq = AsyncMock()  # type: ignore[method-assign]

        # SSRF guard rejects.
        with patch(
            "eden.services.webhook_delivery._assert_public_ip",
            side_effect=ValueError("non-public IP 192.168.1.5"),
        ):
            # Mock ``_get_httpx`` — it IS called once at the top of
            # ``_attempt_delivery`` to get the module reference, but
            # ``AsyncClient`` (the actual post) MUST NOT be invoked.
            fake_httpx = MagicMock()
            with patch(
                "eden.services.webhook_delivery._get_httpx",
                return_value=fake_httpx,
            ):
                await service._attempt_delivery(
                    delivery_id="d-1",
                    url="https://attacker.example/hook",
                    secret="secret",
                    payload={"event": "job.completed"},
                )

        # httpx.AsyncClient (the actual HTTP call) was NEVER instantiated.
        fake_httpx.AsyncClient.assert_not_called()
        # _move_to_dlq was called with this delivery_id.
        service._move_to_dlq.assert_awaited_once()
        # At least one of the execute calls was a status='failed' UPDATE.
        sql_text = " ".join(c[0] for c in execute_calls)
        assert "status = 'failed'" in sql_text, (
            f"S-20 regression: failed SSRF guard did not mark delivery "
            f"as failed. SQL executed: {sql_text}"
        )
        # Error message mentions the SSRF guard.
        ssrf_exc_logged = any(
            "SSRF guard" in str(c[1]) for c in execute_calls
        )
        assert ssrf_exc_logged, (
            "S-20 regression: error_message must mention 'SSRF guard'"
        )

    @pytest.mark.asyncio
    async def test_attempt_delivery_proceeds_when_ssrf_guard_passes(
        self, mock_postgres_client: MagicMock,
    ) -> None:
        """Happy path: when the URL re-validates as public,
        the delivery proceeds normally.
        """
        from eden.services.webhook_delivery import WebhookDeliveryService

        service = WebhookDeliveryService()

        mock_postgres_client.fetchrow = AsyncMock(
            return_value={
                "attempt_count": 0,
                "max_attempts": 7,
                "webhook_id": "wh-1",
            }
        )
        mock_postgres_client.fetch = AsyncMock(return_value=[])

        # Fake httpx that returns 200. The B-25 fix moved to a
        # shared ``httpx.AsyncClient`` (not the per-call
        # ``async with`` pattern the old test mocked), so we
        # patch ``_ensure_http_client`` directly to return a
        # fake client + a permissive Semaphore.
        fake_response = MagicMock()
        fake_response.status_code = 200
        fake_response.text = "ok"

        fake_http = MagicMock()
        fake_http.post = AsyncMock(return_value=fake_response)
        import asyncio as _asyncio
        fake_sem = _asyncio.Semaphore(16)

        async def _fake_ensure():
            return fake_http, fake_sem

        with patch(
            "eden.services.webhook_delivery._assert_public_ip"
        ):  # passes by default
            with patch.object(
                service, "_ensure_http_client", new=_fake_ensure
            ):
                with patch.object(
                    service, "_move_to_dlq", new=AsyncMock()
                ) as mock_dlq:
                    await service._attempt_delivery(
                        delivery_id="d-2",
                        url="https://hooks.example.com/inbound",
                        secret="secret",
                        payload={"event": "job.completed"},
                    )

        # http.post was called.
        fake_http.post.assert_awaited_once()
        # DLQ was NOT touched (delivery succeeded).
        mock_dlq.assert_not_awaited()
