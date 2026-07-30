"""A reset link must never be built on a placeholder domain.

``portal_base_url`` defaults to ``https://portal.example.com`` and
``PORTAL_BASE_URL`` was not set in production. Eden's own
``sign_in_home`` golden probe had been failing against that exact
hostname on every tick — 63 consecutive failures over two hours, and as
far back as the data goes:

    {"error": "Cannot connect to host portal.example.com:443 ssl:default
               [Name or service not known]", "status": "degraded"}

which is how this was found.

It matters beyond the probe. ``send_password_reset_email`` (written
2026-07-30, replacing a function that did not exist at all) builds its
link from that setting. Unset, the fix for "no email is ever sent"
would have become "an email is sent containing a dead link" — strictly
worse, because the user burns their one-time token and cannot tell why.
"""

from __future__ import annotations

import pytest


class _Settings:
    def __init__(self, portal_base_url: str):
        self.portal_base_url = portal_base_url


@pytest.fixture
def _patch_settings(monkeypatch):
    def _apply(url: str):
        import eden.config as cfg

        monkeypatch.setattr(cfg, "get_settings", lambda: _Settings(url))

    return _apply


class TestResetLinkRefusesPlaceholders:
    @pytest.mark.parametrize(
        "url",
        [
            "https://portal.example.com",
            "https://portal.example.com/",
            "http://example.com",
            "",
        ],
    )
    @pytest.mark.asyncio
    async def test_placeholder_or_empty_is_refused(self, _patch_settings, url):
        from eden.services.email_service import send_password_reset_email

        _patch_settings(url)
        with pytest.raises(RuntimeError) as excinfo:
            await send_password_reset_email(to_email="a@b.com", token="t")
        assert "PORTAL_BASE_URL" in str(excinfo.value), (
            "the error must name the setting to fix; a reset failure the "
            "operator cannot action is the same dead end as no email"
        )

    @pytest.mark.asyncio
    async def test_real_origin_builds_the_expected_link(
        self, _patch_settings, monkeypatch
    ):
        import eden.services.email_service as mod

        _patch_settings("https://edenobservability.com")

        captured: dict[str, str] = {}

        class _Svc:
            async def send_email(self, **kwargs):
                captured.update(
                    {k: v for k, v in kwargs.items() if isinstance(v, str)}
                )
                return "sent"

        monkeypatch.setattr(mod, "get_email_service", lambda: _Svc())

        await mod.send_password_reset_email(to_email="a@b.com", token="tok123")

        assert "https://edenobservability.com/reset-password?token=tok123" in (
            captured.get("text_content", "")
        )
        assert "example.com" not in captured.get("html_content", "")
