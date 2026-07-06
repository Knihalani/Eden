"""Regression test for the July 2026 gateway error-redaction fix.

The /v1/chat/completions endpoint was leaking upstream provider error
text directly into its 502 response body::

    raise HTTPException(status_code=502,
        detail=f"upstream error: {exc}") from exc

Where ``exc`` might be::

    openai.AuthenticationError("Incorrect API key provided: sk-proj-***
     *****. You can find your API key at
     https://platform.openai.com/account/api-keys.")

That's a credential leak — the upstream error includes a *prefixed* key.
Other upstream errors leak the upstream hostname (which we may not
want exposed for multi-tenant isolation), the model-name fingerprint
(used for capability probing), and SDK traceback tails.

Fix: redacted via ``_redact_upstream_error``. This test asserts the
function never returns the original exception text.
"""

from __future__ import annotations

from eden.api.routes.gateway import _redact_upstream_error


def test_redaction_does_not_leak_provider_hostname():
    exc = Exception(
        "Connection error: HTTPSConnectionPool(host='api.openai.com',"
        " port=443): Max retries exceeded with url: /v1/chat/completions"
    )
    out = _redact_upstream_error(exc)
    assert "openai.com" not in out
    assert "api.openai.com" not in out


def test_redaction_does_not_leak_api_key_hint():
    # openai-style error includes a prefix of the API key in the
    # message. We must not echo that back.
    exc = Exception(
        "Incorrect API key provided: sk-proj-1aBcDeFgHiJkLmNoPqRsTuV. "
        "You can find your API key at https://platform.openai.com/account/api-keys."
    )
    out = _redact_upstream_error(exc)
    assert "sk-proj-" not in out
    assert "1aBcDeFgHiJkLmNoPqRsTuV" not in out
    assert "platform.openai.com" not in out


def test_redaction_does_not_leak_model_fingerprint():
    exc = Exception(
        "Model 'gpt-4o-2024-08-06-preview-ft-fb789a2c' does not exist "
        "or you do not have access to it."
    )
    out = _redact_upstream_error(exc)
    assert "gpt-4o-2024-08-06-preview-ft" not in out
    assert "fb789a2c" not in out


def test_redaction_returns_a_safe_string():
    out = _redact_upstream_error(RuntimeError("anything"))
    assert isinstance(out, str)
    assert len(out) > 0
    # Must not echo the raw exception
    assert "anything" not in out


# ────────────────────────────────────────────────────────────────────
# _redact_sse_error_message — same intent, SSE path
# ────────────────────────────────────────────────────────────────────


def test_sse_redaction_does_not_leak_provider_hostname():
    from eden.api.routes.gateway import _redact_sse_error_message
    exc = Exception(
        "Connection error: HTTPSConnectionPool(host='api.anthropic.com',"
        " port=443): Read timed out."
    )
    out = _redact_sse_error_message(exc)
    assert "anthropic.com" not in out
    assert "api.anthropic.com" not in out


def test_sse_redaction_does_not_leak_api_key_prefix():
    from eden.api.routes.gateway import _redact_sse_error_message
    exc = Exception(
        "Incorrect API key provided: sk-ant-oN01-***-REDACTED-***."
        " You can find your API key at https://console.anthropic.com."
    )
    out = _redact_sse_error_message(exc)
    assert "sk-ant-" not in out
    assert "console.anthropic.com" not in out


def test_sse_redaction_returns_safe_string():
    from eden.api.routes.gateway import _redact_sse_error_message
    out = _redact_sse_error_message(RuntimeError("anything goes"))
    assert isinstance(out, str)
    assert len(out) > 0
    assert "anything" not in out
