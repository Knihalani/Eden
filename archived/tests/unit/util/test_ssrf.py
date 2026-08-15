"""Unit tests for eden.util.ssrf."""

from __future__ import annotations

import pytest

from eden.util.ssrf import assert_public_https_url


def test_rejects_http_scheme() -> None:
    with pytest.raises(ValueError, match="non-https"):
        assert_public_https_url("http://example.com/v1", what="upstream")


def test_rejects_loopback_literal() -> None:
    with pytest.raises(ValueError, match="non-public"):
        assert_public_https_url("https://127.0.0.1/v1", what="upstream")


def test_rejects_metadata_link_local() -> None:
    with pytest.raises(ValueError, match="non-public"):
        assert_public_https_url("https://169.254.169.254/latest", what="upstream")


def test_rejects_private_rfc1918() -> None:
    with pytest.raises(ValueError, match="non-public"):
        assert_public_https_url("https://10.0.0.5/v1", what="upstream")


def test_rejects_userinfo() -> None:
    with pytest.raises(ValueError, match="userinfo"):
        assert_public_https_url(
            "https://user:pass@example.com/v1", what="upstream"
        )


def test_accepts_public_https_example() -> None:
    # example.com is reserved for documentation and resolves publicly.
    assert_public_https_url("https://example.com/v1", what="upstream")
