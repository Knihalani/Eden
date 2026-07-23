"""Tests for the shared token-extraction + model-normalization helpers."""

from eden_sdk._tokens import extract_usage, normalize_model_name

# ── extract_usage ──────────────────────────────────────────────────


def test_extract_usage_from_anthropic_dict():
    """Anthropic returns a flat dict with input_tokens/output_tokens
    and cache_read_input_tokens / cache_creation_input_tokens."""
    usage = {
        "input_tokens": 100,
        "output_tokens": 50,
        "cache_read_input_tokens": 200,
        "cache_creation_input_tokens": 0,
    }
    out = extract_usage(usage)
    assert out == {
        "input_tokens": 100,
        "output_tokens": 50,
        "cache_read_tokens": 200,
        "cache_creation_tokens": 0,
    }


def test_extract_usage_from_openai_pydantic():
    """OpenAI returns a pydantic model with prompt_tokens /
    completion_tokens and a nested prompt_tokens_details."""
    from types import SimpleNamespace

    ptd = SimpleNamespace(cached_tokens=77)
    usage = SimpleNamespace(
        prompt_tokens=42,
        completion_tokens=99,
        prompt_tokens_details=ptd,
    )
    out = extract_usage(usage)
    assert out == {
        "input_tokens": 42,
        "output_tokens": 99,
        "cache_read_tokens": 77,
        "cache_creation_tokens": None,
    }


def test_extract_usage_openai_camelcase_aliases():
    """OpenAI Python SDK v1 returns camelCase aliases too."""
    usage = {
        "promptTokens": 11,
        "completionTokens": 22,
    }
    out = extract_usage(usage)
    assert out["input_tokens"] == 11
    assert out["output_tokens"] == 22


def test_extract_usage_none_returns_all_none():
    """``None`` usage → all-None result (never zero)."""
    out = extract_usage(None)
    assert out == {
        "input_tokens": None,
        "output_tokens": None,
        "cache_read_tokens": None,
        "cache_creation_tokens": None,
    }


def test_extract_usage_partial_dict():
    """A usage dict that only has output_tokens reports input as
    None (not zero) so billing math doesn't accidentally bill
    free input."""
    out = extract_usage({"completion_tokens": 5})
    assert out["input_tokens"] is None
    assert out["output_tokens"] == 5


def test_extract_usage_ignores_booleans():
    """``True`` / ``False`` are not valid token counts even though
    ``bool`` is technically ``int`` in Python."""
    out = extract_usage({"prompt_tokens": True, "completion_tokens": False})
    assert out["input_tokens"] is None
    assert out["output_tokens"] is None


def test_extract_usage_string_coercion():
    """Some upstream SDKs stringify token counts; coerce."""
    out = extract_usage({"prompt_tokens": "100", "completion_tokens": "20"})
    assert out["input_tokens"] == 100
    assert out["output_tokens"] == 20


def test_extract_usage_unknown_shape_returns_nones():
    """A garbage object returns all-None instead of raising."""
    out = extract_usage(object())
    assert out == {
        "input_tokens": None,
        "output_tokens": None,
        "cache_read_tokens": None,
        "cache_creation_tokens": None,
    }


# ── normalize_model_name ──────────────────────────────────────────


def test_normalize_strips_dash_date_suffix():
    assert normalize_model_name("gpt-4o-2024-08-06") == "gpt-4o"


def test_normalize_strips_compact_date_suffix():
    assert normalize_model_name("claude-3-5-sonnet-20241022") == "claude-3-5-sonnet"


def test_normalize_strips_latest_alias():
    assert normalize_model_name("claude-3-5-sonnet-latest") == "claude-3-5-sonnet"


def test_normalize_keeps_alias_only():
    assert normalize_model_name("gpt-4o") == "gpt-4o"
    assert normalize_model_name("claude-sonnet-4-6") == "claude-sonnet-4-6"


def test_normalize_handles_none_and_empty():
    assert normalize_model_name(None) is None
    assert normalize_model_name("") == ""


def test_normalize_non_string_passthrough():
    """If something weird is passed (shouldn't happen, but defensive)
    we hand it back unchanged."""
    sentinel = 12345
    assert normalize_model_name(sentinel) == sentinel  # type: ignore[arg-type]


# ── normalize_model_name compound cases ────────────────────────────


def test_normalize_strips_compact_date_with_latest_compound():
    """Regression: stripping the date suffix BEFORE ``-latest``
    left the date stamp behind when ``-latest`` followed the date.

    Example: ``claude-sonnet-4-5-20250929-latest`` previously
    normalized to ``claude-sonnet-4-5-20250929`` (date preserved),
    which silently misroutes pricing lookups. The compound regex
    now matches the date + ``-latest`` together so the bare base
    name comes out the other side.
    """
    assert normalize_model_name("claude-sonnet-4-5-20250929-latest") == "claude-sonnet-4-5"


def test_normalize_strips_dashed_date_with_latest_compound():
    assert normalize_model_name("gpt-4-turbo-2024-04-09-latest") == "gpt-4-turbo"


def test_normalize_compact_date_without_latest_still_strips():
    assert normalize_model_name("claude-3-5-sonnet-20241022") == "claude-3-5-sonnet"


def test_normalize_dashed_date_without_latest_still_strips():
    assert normalize_model_name("gpt-4o-2024-08-06") == "gpt-4o"


def test_normalize_bare_latest_still_strips():
    assert normalize_model_name("claude-3-5-sonnet-latest") == "claude-3-5-sonnet"


# ── _coerce_int edge cases ──────────────────────────────────────────
#
# The previous _coerce_int rejected floats entirely, which meant
# a JSON-decoded ``1.0`` (whole-number float) was dropped on the
# floor and ``extract_usage`` reported ``None``. The new version
# accepts whole-number floats and float-strings but rejects
# fractional floats so a ``0.7`` does not silently round to 0
# and under-bill a call.


def test_coerce_int_accepts_whole_number_float() -> None:
    """A JSON-decoded ``1.0`` is a real token count, not 0.7;
    the SDK must accept it. This is the common case when
    providers serialise ``prompt_tokens: 1.0`` instead of
    ``prompt_tokens: 1``."""
    from eden_sdk._tokens import _coerce_int
    assert _coerce_int(1.0) == 1
    assert _coerce_int(0.0) == 0
    assert _coerce_int(100.0) == 100


def test_coerce_int_rejects_fractional_float() -> None:
    """A fractional float (e.g. ``0.7``) must NOT silently
    round down to ``0`` and under-bill a call."""
    from eden_sdk._tokens import _coerce_int
    assert _coerce_int(0.7) is None
    assert _coerce_int(1.5) is None


def test_coerce_int_rejects_nan_and_infinity() -> None:
    """NaN and ±inf are not token counts."""
    from eden_sdk._tokens import _coerce_int
    assert _coerce_int(float("nan")) is None
    assert _coerce_int(float("inf")) is None
    assert _coerce_int(float("-inf")) is None


def test_coerce_int_accepts_whole_number_float_string() -> None:
    """Some providers serialise ``"1.0"`` as a string. Accept
    that, but reject ``"0.7"`` for the same under-billing
    reason."""
    from eden_sdk._tokens import _coerce_int
    assert _coerce_int("1.0") == 1
    assert _coerce_int("100.0") == 100
    assert _coerce_int("0.7") is None


def test_coerce_int_rejects_garbage_string() -> None:
    from eden_sdk._tokens import _coerce_int
    assert _coerce_int("not a number") is None
    assert _coerce_int("") is None


def test_extract_usage_accepts_whole_number_float_tokens() -> None:
    """The full extract_usage path must surface the new float
    acceptance. Regression: a payload of
    ``{"prompt_tokens": 1.0, "completion_tokens": 2.0}`` was
    previously returned as ``None`` for both fields."""
    from eden_sdk._tokens import extract_usage
    out = extract_usage({"prompt_tokens": 1.0, "completion_tokens": 2.0})
    assert out["input_tokens"] == 1
    assert out["output_tokens"] == 2


# ── _extract_usage camelCase / top-level aliases ─────────────────────
#
# The Python SDK previously only checked the nested OpenAI
# ``prompt_tokens_details.cached_tokens`` for cache-read
# tokens. Some OpenAI-compatible gateways (and older OpenAI
# SDK responses) expose the same value as a top-level
# ``cached_tokens`` (snake_case) or ``cachedTokens``
# (camelCase) field. The TypeScript SDK already accepts
# both — bring the Python SDK to parity.


def test_extract_usage_accepts_top_level_cached_tokens_snake() -> None:
    from eden_sdk._tokens import extract_usage
    out = extract_usage({"cached_tokens": 17, "input_tokens": 100})
    assert out["cache_read_tokens"] == 17
    assert out["input_tokens"] == 100


def test_extract_usage_accepts_top_level_cached_tokens_camel() -> None:
    from eden_sdk._tokens import extract_usage
    out = extract_usage({"cachedTokens": 22, "input_tokens": 50})
    assert out["cache_read_tokens"] == 22


def test_extract_usage_accepts_camel_prompt_tokens_details() -> None:
    from eden_sdk._tokens import extract_usage
    out = extract_usage({"promptTokensDetails": {"cached_tokens": 31}})
    assert out["cache_read_tokens"] == 31


# ── Bedrock Converse / Gemini usageMetadata aliases ──────────────────
#
# Both providers' native camelCase field names route through the same
# shared extractor so the openai/anthropic/bedrock/gemini instrumentations
# all agree on the wire's billing field names.


def test_extract_usage_accepts_bedrock_converse_camelcase() -> None:
    from eden_sdk._tokens import extract_usage
    out = extract_usage(
        {
            "inputTokens": 10,
            "outputTokens": 5,
            "cacheReadInputTokens": 200,
            "cacheWriteInputTokens": 50,
        }
    )
    assert out["input_tokens"] == 10
    assert out["output_tokens"] == 5
    assert out["cache_read_tokens"] == 200
    assert out["cache_creation_tokens"] == 50


def test_extract_usage_accepts_gemini_usage_metadata_shape() -> None:
    from eden_sdk._tokens import extract_usage
    out = extract_usage(
        {
            "promptTokenCount": 60,
            "candidatesTokenCount": 25,
            "cachedContentTokenCount": 40,
        }
    )
    assert out["input_tokens"] == 60
    assert out["output_tokens"] == 25
    assert out["cache_read_tokens"] == 40
