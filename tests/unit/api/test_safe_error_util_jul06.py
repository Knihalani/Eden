"""Regression tests for the July 2026 site-wide error-redaction util.

``src/eden/api/utils/safe_error.py`` consolidates two redactors
(``safe_detail`` for 5xx ``detail=`` strings, ``redact_upstream_error``
for 502 / 504 upstream-provider bodies) that were previously
duplicated across ``gateway.py``, ``prompt_canary.py``, and a
half-dozen leak sites that still echoed ``str(exc)`` verbatim.

This file pins:

- The default ``safe_detail`` returns a fixed, non-leaking string.
- ``fallback=...`` returns the supplied fallback (no concatenation
  with the exception text).
- ``redact_upstream_error`` returns the fixed upstream-provider
  string, distinct from the generic 5xx message so a client can
  tell "the upstream is down" from "the server crashed".
- The helpers never embed the exception message, the exception
  class name, the traceback, or any upstream-provider URLs / API
  key prefixes / model fingerprints the upstream error text might
  carry.
"""

from __future__ import annotations

import re

from eden.api.utils.safe_error import redact_upstream_error, safe_detail


# Realistic upstream error text — exactly the kind of strings these
# helpers are meant to scrub from client responses.
_API_KEY_LEAK = (
    "Incorrect API key provided: sk-proj-abcdef1234567890. "
    "You can find your API key at https://platform.openai.com/account/api-keys."
)
_PROVIDER_HOST_LEAK = (
    "ConnectionError: HTTPSConnectionPool(host='api.anthropic.com', "
    "port=443): Max retries exceeded with url: /v1/messages"
)
_MODEL_FINGERPRINT_LEAK = (
    "openai.NotFoundError: The model 'gpt-4o-2024-08-06-preview-ft-fb789a2c' "
    "does not exist or you do not have access to it."
)
_DB_SCHEMA_LEAK = (
    'asyncpg.exceptions.UniqueViolationError: duplicate key value '
    'violates unique constraint "prompt_canary_experiments_experiment_id_key" '
    'DETAIL: Key (experiment_id)=(d3bca4e2-3f8a-4d29-9f12) already exists.'
)


def test_safe_detail_default_returns_generic_text():
    out = safe_detail(Exception("anything goes"))
    assert out == "Internal server error"
    assert "anything goes" not in out


def test_safe_detail_fallback_overrides_default():
    out = safe_detail(Exception("leaked"), fallback="Could not save canary")
    assert out == "Could not save canary"
    assert "leaked" not in out
    assert "Could not save canary" == out


def test_safe_detail_never_embeds_api_key():
    exc = Exception(_API_KEY_LEAK)
    out = safe_detail(exc)
    assert "sk-proj-" not in out
    assert "platform.openai.com" not in out


def test_safe_detail_never_embeds_provider_host():
    exc = Exception(_PROVIDER_HOST_LEAK)
    out = safe_detail(exc)
    assert "api.anthropic.com" not in out
    assert "anthropic" not in out.lower()


def test_safe_detail_never_embeds_model_fingerprint():
    exc = Exception(_MODEL_FINGERPRINT_LEAK)
    out = safe_detail(exc)
    assert "gpt-4o" not in out
    assert "fb789a2c" not in out


def test_safe_detail_never_embeds_db_schema():
    exc = Exception(_DB_SCHEMA_LEAK)
    out = safe_detail(exc)
    assert "prompt_canary_experiments" not in out
    assert "experiment_id_key" not in out
    assert "d3bca4e2" not in out


def test_safe_detail_never_embeds_exception_class_name():
    exc = ValueError("some user input was wrong")
    out = safe_detail(exc)
    assert "ValueError" not in out
    assert "some user input" not in out


def test_safe_detail_fallback_passes_through_verbatim():
    """Caller-provided fallback is used verbatim — no transformation."""
    out = safe_detail(Exception("x"), fallback="Cannot save retention policy")
    assert out == "Cannot save retention policy"


def test_redact_upstream_error_returns_distinct_string():
    """Upstream redaction must be distinguishable from the generic
    5xx message so clients can branch on it (``"the upstream is
    down, retry with backoff"`` vs ``"server-side bug, file a
    ticket"``)."""
    upstream = redact_upstream_error(Exception("anything"))
    generic = safe_detail(Exception("anything"))
    assert upstream != generic
    # Both are short, neutral, non-leaking.
    assert len(upstream) < 80
    assert "upstream" in upstream.lower()


def test_redact_upstream_error_never_embeds_secrets():
    out = redact_upstream_error(Exception(_API_KEY_LEAK))
    assert "sk-proj-" not in out
    assert "openai.com" not in out


def test_redact_upstream_error_never_embeds_provider_host():
    out = redact_upstream_error(Exception(_PROVIDER_HOST_LEAK))
    assert "api.anthropic.com" not in out
    assert "anthropic" not in out.lower()


def test_redact_upstream_error_never_embeds_model_fingerprint():
    out = redact_upstream_error(Exception(_MODEL_FINGERPRINT_LEAK))
    assert "gpt-4o" not in out
    assert "fb789a2c" not in out


# Patterns that every safe-string return value MUST respect.
_LEAK_PATTERN = re.compile(
    r"sk-(?:ant|proj)-|"          # API-key prefixes (openai + anthropic)
    r"api\.(?:openai|anthropic)\.com|"  # provider hostnames
    r"gpt-4[o-]?|"                 # OpenAI model fingerprints
    r"claude-(?:opus|sonnet|haiku)-|"  # Anthropic model fingerprints
    r"unique constraint|"          # asyncpg constraint names
    r"asyncpg\.|openai\.|anthropic\.|httpx\."  # SDK / library names
)


def test_no_helper_ever_returns_a_string_with_known_leak_patterns():
    """Exhaustive sweep: every (helper, sample exception text) pair
    produces a string with no known leak patterns."""
    samples = [
        Exception(_API_KEY_LEAK),
        Exception(_PROVIDER_HOST_LEAK),
        Exception(_MODEL_FINGERPRINT_LEAK),
        Exception(_DB_SCHEMA_LEAK),
        RuntimeError("boom"),
    ]
    for exc in samples:
        for out in (
            safe_detail(exc),
            safe_detail(exc, fallback="Cannot save policy"),
            redact_upstream_error(exc),
        ):
            assert not _LEAK_PATTERN.search(out), (
                f"leak detected in helper output {out!r} for exc {exc!r}"
            )
