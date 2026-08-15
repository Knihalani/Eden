"""D12 — agent session contract tests."""

from __future__ import annotations

from eden.services.session_contract import (
    CONTRACT_VERSION,
    SESSION_CONTRACT,
    validate_session_payload,
)


def test_contract_version_present() -> None:
    assert CONTRACT_VERSION == "eden-agent-session-v1"
    assert "api_endpoints" in SESSION_CONTRACT


def test_validate_session_payload_end_requires_success() -> None:
    errs = validate_session_payload({"phase": "end"})
    assert "missing success on end" in errs
