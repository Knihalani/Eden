"""M12 (§7.2) leak canary — fake secrets must not escape evidence surfaces.

A stumble detail carrying a fake ``ghp_…`` token must never appear in:
* the failure-pack excerpt
* plan evidence JSON (failure signature / pack fields)
* the rendered PR body
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest

from eden.improvement.approve import render_pr_evidence_body
from eden.improvement.evidence_plane import build_failure_pack
from eden.issues.fixture_export import _redact, redact_secret_values

# Fake GitHub PAT shaped like a real token (ghp_ + ≥20 alnum).
_CANARY_GHP = "ghp_LeakCanaryToken0000000000001"
_ORG = "org_canary"
_ISSUE = "iss_canary"


def test_redact_value_patterns_cover_common_secrets() -> None:
    """Direct value-pattern coverage beyond the canary path."""
    samples = {
        "jwt": (
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
            "eyJzdWIiOiIxMjM0NTY3ODkwIn0."
            "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
        ),
        "sk-": "sk-" + ("a" * 24),
        "ghp_": _CANARY_GHP,
        "xoxb-": "xox" + "b-" + "leakcanary00-" + ("a" * 12),
        "pem": (
            "-----BEGIN RSA PRIVATE KEY-----\n"
            "MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF6PZGFw+\n"
            "-----END RSA PRIVATE KEY-----"
        ),
        "api_key": 'api_key = "abcdefghijklmnopqrstuvwxyz12"',
    }
    for name, secret in samples.items():
        out = redact_secret_values(f"seen {secret} in log")
        assert secret not in out, name
        assert f"[REDACTED:{name}]" in out, name


def test_redact_key_name_still_wins() -> None:
    out = _redact({"token": _CANARY_GHP, "msg": f"auth {_CANARY_GHP}"})
    assert out["token"] == "[REDACTED]"
    assert _CANARY_GHP not in out["msg"]
    assert "[REDACTED:ghp_]" in out["msg"]


@pytest.mark.asyncio
async def test_leak_canary_pack_excerpt_and_evidence() -> None:
    """Unredacted upstream fixture still gets scrubbed at pack-build choke point."""
    fixture = {
        "format": "eden-failure-fixture-v1",
        "issue": {
            "id": _ISSUE,
            "fingerprint": "fp",
            "kind": "tool_error",
            "title": "auth boom",
            "severity": "p1",
        },
        "traces": [
            {
                "trace_id": "trc-canary",
                "detail": {
                    "kind": "tool_error",
                    "error": f"GitHub auth failed with {_CANARY_GHP}",
                },
                "spans": [
                    {
                        "name": "github.call",
                        "attributes": {
                            "error": f"token {_CANARY_GHP} rejected",
                        },
                    }
                ],
            }
        ],
    }
    with patch(
        "eden.issues.fixture_export.export_issue_fixture",
        AsyncMock(return_value={"status": "ok", "fixture": fixture}),
    ):
        pack = await build_failure_pack(_ORG, _ISSUE)

    assert pack["status"] == "ok"
    assert _CANARY_GHP not in pack["excerpt"]
    pack_json = json.dumps(pack, default=str)
    assert _CANARY_GHP not in pack_json
    assert "[REDACTED:ghp_]" in pack["excerpt"]

    # Plan evidence carries the (already-redacted) failure signature.
    evidence = {
        "issue_id": _ISSUE,
        "evidence_tier": "static",
        "example_trace_ids": pack["example_trace_ids"],
        "failure_signature": pack.get("failure_signature"),
        "hermetic_preverify": {"status": "static_passed"},
    }
    evidence_json = json.dumps(evidence, default=str)
    assert _CANARY_GHP not in evidence_json


def test_leak_canary_pr_body() -> None:
    """Even if evidence somehow still holds the canary, PR render scrubs it."""
    plan = {
        "evidence": {
            "issue_id": _ISSUE,
            "evidence_tier": "static",
            "example_trace_ids": ["trc-canary"],
            "failure_signature": {
                "stumble_kind": "tool_error",
                "error_substring": f"auth failed {_CANARY_GHP}",
                "failing_span_name": "github.call",
            },
        }
    }
    body = render_pr_evidence_body(
        plan,
        plan_id="plan-canary",
        summary=f"Fix auth path that leaked {_CANARY_GHP}",
    )
    assert _CANARY_GHP not in body
    assert "[REDACTED:ghp_]" in body
