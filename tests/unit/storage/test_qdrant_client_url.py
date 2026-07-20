"""Qdrant client URL resolution — Errno 99 hardening.

Prod evidence (w2-07): /health returns degraded with
``qdrant: error: [Errno 99] Cannot assign requested address`` while
Postgres stays connected. Root cause was HTTP host/port construction
when HTTPS was unset OR when API key emptiness gated HTTPS away.
"""

from __future__ import annotations

from eden.storage.qdrant import resolve_qdrant_client_kwargs

CLOUD_HOST = "58384b79-0261-480e-b61f-d86bbf1c0dad.us-east4-0.gcp.cloud.qdrant.io"


def test_https_true_builds_url_even_without_api_key():
    """Regression: empty API key must NOT fall back to HTTP host/port."""
    kwargs = resolve_qdrant_client_kwargs(
        host=CLOUD_HOST,
        port=6333,
        https=True,
        api_key="",
    )
    assert "url" in kwargs
    assert kwargs["url"] == f"https://{CLOUD_HOST}:6333"
    assert "host" not in kwargs
    assert "api_key" not in kwargs


def test_https_true_with_api_key():
    kwargs = resolve_qdrant_client_kwargs(
        host=CLOUD_HOST,
        port=6333,
        https=True,
        api_key="qk-test",
    )
    assert kwargs == {
        "url": f"https://{CLOUD_HOST}:6333",
        "api_key": "qk-test",
    }


def test_cloud_host_auto_https_when_flag_unset():
    """QDRANT_HTTPS unset/false + cloud hostname → still use url=https."""
    kwargs = resolve_qdrant_client_kwargs(
        host=CLOUD_HOST,
        port=6333,
        https=False,
        api_key="qk-test",
    )
    assert kwargs["url"].startswith("https://")
    assert kwargs["api_key"] == "qk-test"


def test_local_http_dev_path_unchanged():
    kwargs = resolve_qdrant_client_kwargs(
        host="localhost",
        port=6333,
        https=False,
        api_key="",
    )
    assert kwargs == {"host": "localhost", "port": 6333}


def test_local_http_can_still_pass_api_key():
    kwargs = resolve_qdrant_client_kwargs(
        host="localhost",
        port=6333,
        https=False,
        api_key="local-key",
    )
    assert kwargs == {"host": "localhost", "port": 6333, "api_key": "local-key"}


def test_old_and_gate_would_have_chosen_http_against_cloud():
    """Document the pre-fix misconfig: https AND key — empty key → HTTP.

    That HTTP path against Cloud is what produced Errno 99 in prod.
    """
    https = True
    api_key = ""
    # Old gate (buggy):
    use_url = bool(https and api_key)
    assert use_url is False  # would have used host/port HTTP → Errno 99
    # New resolver:
    kwargs = resolve_qdrant_client_kwargs(
        host=CLOUD_HOST, port=6333, https=https, api_key=api_key
    )
    assert "url" in kwargs
