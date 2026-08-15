"""Unit tests for redteam target_endpoint SSRF guard (reject-path only)."""

from __future__ import annotations

import socket
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from eden.api.routes.redteam import _validate_target_endpoint


def test_rejects_non_https() -> None:
    with pytest.raises(HTTPException) as ei:
        _validate_target_endpoint("http://example.com/agent")
    assert ei.value.status_code == 400
    assert "HTTPS" in ei.value.detail


def test_rejects_userinfo() -> None:
    with pytest.raises(HTTPException) as ei:
        _validate_target_endpoint("https://user:pass@example.com/agent")
    assert ei.value.status_code == 400
    assert "userinfo" in ei.value.detail


def test_rejects_loopback_literal() -> None:
    with pytest.raises(HTTPException) as ei:
        _validate_target_endpoint("https://127.0.0.1/agent")
    assert ei.value.status_code == 400
    assert "public IP" in ei.value.detail


def test_rejects_link_local_literal() -> None:
    with pytest.raises(HTTPException) as ei:
        _validate_target_endpoint("https://169.254.169.254/latest/meta-data/")
    assert ei.value.status_code == 400
    assert "public IP" in ei.value.detail


def test_rejects_private_literal() -> None:
    with pytest.raises(HTTPException) as ei:
        _validate_target_endpoint("https://10.0.0.5/agent")
    assert ei.value.status_code == 400


def test_rejects_unresolvable_host() -> None:
    with patch(
        "eden.api.routes.redteam.socket.getaddrinfo",
        side_effect=socket.gaierror(8, "nodename nor servname"),
    ):
        with pytest.raises(HTTPException) as ei:
            _validate_target_endpoint("https://no-such-host.invalid/agent")
        assert ei.value.status_code == 400
        assert "resolved" in ei.value.detail


def test_rejects_when_any_resolved_address_is_private() -> None:
    infos = [
        (socket.AF_INET, socket.SOCK_STREAM, 0, "", ("1.1.1.1", 0)),
        (socket.AF_INET, socket.SOCK_STREAM, 0, "", ("10.0.0.1", 0)),
    ]
    with patch(
        "eden.api.routes.redteam.socket.getaddrinfo",
        return_value=infos,
    ):
        with pytest.raises(HTTPException) as ei:
            _validate_target_endpoint("https://mixed.example/agent")
        assert ei.value.status_code == 400
        assert "public IP" in ei.value.detail


def test_allowlist_rejects_non_listed_host(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "EDEN_REDTEAM_ENDPOINT_ALLOWLIST", "allowed.example"
    )
    with pytest.raises(HTTPException) as ei:
        _validate_target_endpoint("https://other.example/agent")
    assert ei.value.status_code == 400
    assert "ALLOWLIST" in ei.value.detail
