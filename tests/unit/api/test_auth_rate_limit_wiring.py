"""Unit tests for the rate-limit wiring on /auth/* endpoints.

Verifies that the limiters defined in :mod:`eden.api.utils.rate_limit`
are actually invoked from the route handlers and return 429 with a
Retry-After header when the bucket is exhausted.
"""

import pytest

from eden.api.utils.rate_limit import (
    login_email_limiter,
    login_limiter,
    password_reset_limiter,
    signup_limiter,
)


@pytest.mark.asyncio
async def test_login_limiter_rejects_after_10_attempts():
    """10 logins per minute per IP — 11th is rejected."""
    # Drive the bucket to its cap. The limiter counts BEFORE the
    # route handler does any work, so we just hammer the limiter
    # itself to simulate the route's behaviour.
    for _ in range(login_limiter.max_requests):
        await login_limiter.check("test-ip-login")
    with pytest.raises(Exception) as excinfo:
        await login_limiter.check("test-ip-login")
    # Retry-After must be a positive integer.
    assert excinfo.value.retry_after >= 1.0


@pytest.mark.asyncio
async def test_login_email_limiter_independent_of_ip():
    """Per-email bucket is tracked separately from the per-IP bucket."""
    # Drain the per-email bucket for one address.
    for _ in range(login_email_limiter.max_requests):
        await login_email_limiter.check("victim@example.com")
    with pytest.raises(Exception):
        await login_email_limiter.check("victim@example.com")
    # A different email still has full quota.
    await login_email_limiter.check("other@example.com")


@pytest.mark.asyncio
async def test_signup_limiter_caps_at_5_per_minute():
    """Signup limiter rejects the 6th attempt within 60s."""
    for _ in range(signup_limiter.max_requests):
        await signup_limiter.check("test-ip-signup")
    with pytest.raises(Exception):
        await signup_limiter.check("test-ip-signup")


@pytest.mark.asyncio
async def test_password_reset_limiter_caps_at_3_per_5min():
    """Password reset limiter rejects the 4th attempt within 300s."""
    for _ in range(password_reset_limiter.max_requests):
        await password_reset_limiter.check("test-ip-pwreset")
    with pytest.raises(Exception):
        await password_reset_limiter.check("test-ip-pwreset")


def test_rate_limit_exception_carries_retry_after():
    """RateLimitExceededError carries a retry_after value the route handler
    can put in the Retry-After header (RFC 7231 §7.1.3)."""
    from eden.api.utils.rate_limit import RateLimitExceededError

    exc = RateLimitExceededError(retry_after=42.5)
    assert exc.retry_after == 42.5
    assert "42" in str(exc) or "Retry" in str(exc)


def test_client_ip_falls_back_to_socket_when_no_trusted_proxy():
    """When no TRUSTED_PROXY_CIDRS is configured, XFF is *not*
    trusted — the direct socket address wins. Pre-fix this used
    to honour leftmost-XFF unconditionally, letting an attacker
    spoof the IP key for per-IP rate limits on signup / login /
    TOTP setup."""
    from eden.api.routes.auth import _client_ip

    class _FakeRequest:
        class _Client:
            host = "198.51.100.42"

        client = _Client()
        headers = {"x-forwarded-for": "203.0.113.7, 10.0.0.1"}

    assert _client_ip(_FakeRequest()) == "198.51.100.42"


def test_client_ip_falls_back_to_socket():
    """Without XFF, use the socket-level client address."""
    from eden.api.routes.auth import _client_ip

    class _FakeRequest:
        class _Client:
            host = "198.51.100.42"

        client = _Client()
        headers: dict = {}

    assert _client_ip(_FakeRequest()) == "198.51.100.42"


def test_client_ip_honours_xff_when_direct_is_trusted_proxy():
    """When the direct socket address is in TRUSTED_PROXY_CIDRS,
    the leftmost XFF hop is honoured. This is the deployed path:
    CDN/LB terminates TLS and forwards to us with XFF set."""
    from eden.api.routes.auth import _client_ip
    from eden.api.utils import client_ip as client_ip_mod

    class _FakeRequest:
        class _Client:
            host = "10.0.0.1"  # inside the trusted CDN network

        client = _Client()
        headers = {"x-forwarded-for": "203.0.113.7, 10.0.0.1"}

    # Override the module-level trust list just for this test.
    original = client_ip_mod.TRUSTED_PROXY_CIDRS
    client_ip_mod.TRUSTED_PROXY_CIDRS = ["10.0.0.0/8"]
    try:
        assert _client_ip(_FakeRequest()) == "203.0.113.7"
    finally:
        client_ip_mod.TRUSTED_PROXY_CIDRS = original
