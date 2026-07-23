"""Token-billing normalization helpers shared across instrumentations.

Both providers surface the same conceptual numbers (input, output,
cache-read, cache-creation) under slightly different field names —
this module is the single source of truth for collapsing them into
the canonical shape the backend expects.
"""

from __future__ import annotations

import re
from typing import Any

# ── Usage extraction ────────────────────────────────────────────────

def _coerce_int(value: Any) -> int | None:
    """Coerce a token-count-ish value to ``int`` or return ``None``.

    Accepts ``int`` (excluding ``bool``), numeric strings
    (``"100"`` → ``100``), and whole-number floats (``1.0`` →
    ``1``). Rejects booleans, ``None``, NaN / infinity, and
    fractional floats (the SDK would otherwise silently round
    ``0.7`` to ``0`` and under-bill a call).

    The TypeScript SDK's ``coerceInt`` historically was
    slightly more permissive — it accepted any finite number
    including fractional floats. The 0.2.18 release tightened
    it to match the Python SDK (whole-number floats only;
    fractional values return ``null``), so the two SDKs now
    agree on what counts as a valid token count and a call
    cannot be billed for a fractional token from either
    language.
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        # Reject NaN / infinity. Whole-number floats (the
        # typical JSON-decoded ``1.0``) round-trip cleanly;
        # fractional floats (``0.7``) are dropped rather than
        # silently rounded down to ``0`` and under-billed.
        if not (value == value and value not in (float("inf"), float("-inf"))):
            return None
        if value != int(value):
            return None
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            # Some providers serialise floats as strings
            # (``"1.0"``); accept those but reject
            # fractional strings (``"0.7"``).
            try:
                f = float(value)
            except ValueError:
                return None
            if not (f == f and f not in (float("inf"), float("-inf"))):
                return None
            if f != int(f):
                return None
            return int(f)
    return None


def _get(usage: Any, *names: str) -> Any:
    """Look up a field on either a dict or an attribute-bearing
    object (Pydantic models, ``SimpleNamespace``, etc.)."""
    for name in names:
        if isinstance(usage, dict):
            if name in usage:
                return usage[name]
        else:
            if hasattr(usage, name):
                return getattr(usage, name)
    return None


def extract_usage(usage: Any) -> dict[str, int | None]:
    """Return a normalized usage dict from any provider's usage blob.

    Accepts both OpenAI (``prompt_tokens`` / ``completion_tokens``)
    and Anthropic (``input_tokens`` / ``output_tokens``) shapes,
    plus nested OpenAI ``prompt_tokens_details.cached_tokens`` and
    Anthropic ``cache_read_input_tokens`` / ``cache_creation_input_tokens``.

    Booleans, ``None``, and non-numeric strings are ignored — only
    real numbers make it into the result, so callers can rely on
    ``input_tokens`` being either a positive ``int`` or ``None``
    (not ``False``, not ``"100"``).

    Returns
    -------
    dict with keys ``input_tokens``, ``output_tokens``,
    ``cache_read_tokens``, ``cache_creation_tokens`` (each
    ``int | None``).
    """
    if not usage:
        return {
            "input_tokens": None,
            "output_tokens": None,
            "cache_read_tokens": None,
            "cache_creation_tokens": None,
        }

    input_tokens = _coerce_int(
        # ``inputTokens`` is the Bedrock Converse API's top-level
        # ``usage`` shape. ``promptTokenCount`` is Gemini's REST /
        # ``usageMetadata`` shape; ``prompt_token_count`` is the
        # same field as a snake_case Python SDK attribute (the
        # legacy ``google-generativeai`` package's ``UsageMetadata``
        # model).
        _get(
            usage,
            "input_tokens",
            "prompt_tokens",
            "promptTokens",
            "inputTokens",
            "promptTokenCount",
            "prompt_token_count",
        )
    )
    output_tokens = _coerce_int(
        _get(
            usage,
            "output_tokens",
            "completion_tokens",
            "completionTokens",
            "outputTokens",
            "candidatesTokenCount",
            "candidates_token_count",
        )
    )

    cache_read_tokens: int | None = None
    # Match the TypeScript SDK's key list exactly so the two
    # SDKs surface identical billing fields regardless of
    # which OpenAI-shaped shape the caller hands us.
    for name in (
        "cache_read_tokens",
        "cache_read_input_tokens",
        "cacheReadInputTokens",  # Bedrock Converse API top-level `usage` shape.
        "cached_tokens",
        "cachedTokens",
        "cachedContentTokenCount",  # Gemini `usageMetadata` shape.
        "cached_content_token_count",  # Gemini snake_case SDK attribute.
    ):
        v = _coerce_int(_get(usage, name))
        if v is not None:
            cache_read_tokens = v
            break
    if cache_read_tokens is None:
        # OpenAI nests cached prompt tokens inside
        # ``prompt_tokens_details.cached_tokens``. We also
        # accept the camelCase form (``promptTokensDetails``)
        # for parity with the TypeScript SDK.
        for details_name in ("prompt_tokens_details", "promptTokensDetails"):
            details = _get(usage, details_name)
            if details is not None:
                v = _coerce_int(_get(details, "cached_tokens") or _get(details, "cachedTokens"))
                if v is not None:
                    cache_read_tokens = v
                    break

    cache_creation_tokens: int | None = None
    for name in (
        "cache_creation_tokens",
        "cache_creation_input_tokens",
        "cacheWriteInputTokens",  # Bedrock Converse API top-level `usage` shape.
    ):
        v = _coerce_int(_get(usage, name))
        if v is not None:
            cache_creation_tokens = v
            break

    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_read_tokens": cache_read_tokens,
        "cache_creation_tokens": cache_creation_tokens,
    }


# ── Model name normalization ───────────────────────────────────────

# Strip dated suffixes so pricing lookups hit a single row
# regardless of which alias the caller used.

# Optional trailing ``-latest`` that may follow either date format
# (e.g. ``claude-sonnet-4-5-20250929-latest``). Must be matched as
# part of the suffix regex so a trailing ``-latest`` doesn't leave
# the date stamp stranded in the normalized output.
_DATE_SUFFIX_RE_WITH_LATEST = re.compile(r"-\d{4}-\d{2}-\d{2}(?:-latest)?$")
_DATE_LIKE_RE_WITH_LATEST = re.compile(r"-\d{8}(?:-latest)?$")
_LATEST_TAIL_RE = re.compile(r"-latest$")


def normalize_model_name(model: str | None) -> str | None:
    """Strip dated suffixes so pricing lookups hit a single row.

    Examples
    --------
    >>> normalize_model_name("gpt-4o-2024-08-06")
    'gpt-4o'
    >>> normalize_model_name("claude-3-5-sonnet-20241022")
    'claude-3-5-sonnet'
    >>> normalize_model_name("gpt-4o")
    'gpt-4o'
    >>> normalize_model_name("claude-sonnet-4-5-20250929-latest")
    'claude-sonnet-4-5'
    """
    if not model or not isinstance(model, str):
        return model
    # Strip a date-then-latest tail first (matches both
    # ``-YYYY-MM-DD-latest`` and ``-YYYYMMDD-latest``), then the
    # bare date suffix, then a bare ``-latest`` if it remains.
    # Doing them in this order keeps
    # ``claude-sonnet-4-5-20250929-latest`` from leaving the date
    # stamp in the output (the prior order stripped ``-latest``
    # AFTER the date regexes, so the date regexes never saw
    # ``-latest`` and bailed out, leaving the date stamp behind).
    out = _DATE_SUFFIX_RE_WITH_LATEST.sub("", model)
    out = _DATE_LIKE_RE_WITH_LATEST.sub("", out)
    out = _LATEST_TAIL_RE.sub("", out)
    return out


__all__ = ["extract_usage", "normalize_model_name"]
