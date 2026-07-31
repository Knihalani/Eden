"""Unit tests for GitHub App install URL construction.

Regression: ``get_install_url`` used ``client_id`` (``Iv23…``) as the
app slug, producing ``github.com/apps/Iv23…/installations/new`` 404s
and empty ``redirect_uri=`` when callback env was unset.
"""

from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import pytest

from eden.integrations.github import oauth as github_oauth
from eden.integrations.github.oauth import GitHubOAuthClient


@pytest.fixture(autouse=True)
def _stub_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(github_oauth, "is_configured", lambda: True)

    # Avoid reading real Settings / .env in these pure URL tests.
    class _S:
        github_app_id = "12345"
        github_app_client_id = "Iv23li1ZkNSgbK9X2pcZ"
        github_app_client_secret = "secret"
        github_app_private_key = "-----BEGIN RSA PRIVATE KEY-----\nk\n-----END RSA PRIVATE KEY-----"
        github_app_slug = ""
        github_app_callback_url = ""
        app_url = "https://edenobservability.com"
        portal_base_url = "https://edenobservability.com"

    monkeypatch.setattr(github_oauth, "get_settings", lambda: _S())


def _client(**kwargs: str) -> GitHubOAuthClient:
    defaults = {
        "app_id": "12345",
        "client_id": "Iv23li1ZkNSgbK9X2pcZ",
        "client_secret": "secret",
        "private_key": "-----BEGIN RSA PRIVATE KEY-----\nk\n-----END RSA PRIVATE KEY-----",
        "app_slug": "eden-observability",
        "callback_url": "https://edenobservability.com/agents/connect",
    }
    defaults.update(kwargs)
    return GitHubOAuthClient(**defaults)


def test_install_url_uses_slug_not_client_id() -> None:
    client = _client()
    url = client.get_install_url(state="csrf-token-1")
    parsed = urlparse(url)
    assert parsed.netloc == "github.com"
    assert parsed.path == "/apps/eden-observability/installations/new"
    qs = parse_qs(parsed.query)
    assert qs["state"] == ["csrf-token-1"]
    assert qs["redirect_uri"] == ["https://edenobservability.com/agents/connect"]
    assert "Iv23" not in parsed.path


def test_install_url_never_uses_iv_client_id_as_slug() -> None:
    client = _client(app_slug="Iv23li1ZkNSgbK9X2pcZ")
    url = client.get_install_url(state="s")
    assert "/apps/eden-observability/installations/new" in url
    assert "Iv23" not in urlparse(url).path


def test_callback_defaults_when_empty() -> None:
    client = _client(callback_url="")
    assert client.callback_url.endswith("/agents/connect")
    assert "example.com" not in client.callback_url
    url = client.get_install_url(state="s")
    qs = parse_qs(urlparse(url).query)
    assert qs["redirect_uri"][0]


def test_private_key_looks_loadable() -> None:
    assert github_oauth._private_key_looks_loadable("") is False
    assert (
        github_oauth._private_key_looks_loadable("-----BEGIN RSA PRIVATE KEY-----")
        is False
    )
    full = (
        "-----BEGIN RSA PRIVATE KEY-----\n"
        + ("x" * 64)
        + "\n-----END RSA PRIVATE KEY-----"
    )
    assert github_oauth._private_key_looks_loadable(full) is True


def test_is_configured_pem_gate(monkeypatch: pytest.MonkeyPatch) -> None:
    """Mirror is_configured()'s predicate — header-only PEM must fail."""

    class _Broken:
        github_app_id = "4060900"
        github_app_client_id = "Iv23li1ZkNSgbK9X2pcZ"
        github_app_client_secret = "secret"
        github_app_private_key = "-----BEGIN RSA PRIVATE KEY-----"

    class _Ok:
        github_app_id = "4060900"
        github_app_client_id = "Iv23li1ZkNSgbK9X2pcZ"
        github_app_client_secret = "secret"
        github_app_private_key = (
            "-----BEGIN RSA PRIVATE KEY-----\n"
            + ("A" * 64)
            + "\n-----END RSA PRIVATE KEY-----"
        )

    def _gate(s: object) -> bool:
        return all(
            [
                getattr(s, "github_app_id", "").strip(),
                getattr(s, "github_app_client_id", "").strip(),
                getattr(s, "github_app_client_secret", "").strip(),
                github_oauth._private_key_looks_loadable(
                    getattr(s, "github_app_private_key", "")
                ),
            ]
        )

    assert _gate(_Broken()) is False
    assert _gate(_Ok()) is True
    monkeypatch.setattr(github_oauth, "get_settings", lambda: _Ok())
    assert _gate(github_oauth.get_settings()) is True
