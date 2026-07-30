"""Safe jsonb metric cast helpers."""

from __future__ import annotations

from eden.storage.sql_safe import (
    safe_cost_coalesce_sql,
    safe_cost_sum_sql,
    safe_token_coalesce_sql,
    safe_token_field,
    safe_token_sum_sql,
)


def test_safe_token_field_uses_numeric_not_bare_int():
    frag = safe_token_field("input_tokens", alias="e.")
    assert "::numeric" in frag
    assert "e.metrics->>'input_tokens'" in frag
    assert "::int" not in frag


def test_safe_token_sum_accepts_float_text_shape():
    frag = safe_token_sum_sql(alias="e.")
    assert "::numeric" in frag
    assert frag.endswith("::int")
    assert "NULLIF" in frag


def test_safe_cost_sum_nullif_empty():
    frag = safe_cost_sum_sql()
    assert "NULLIF" in frag
    assert "cost_usd" in frag


def test_safe_token_coalesce_ladder():
    frag = safe_token_coalesce_sql(
        ("payload", "input_tokens"),
        ("metrics", "input_tokens"),
        fallback="usage_prompt_tokens",
    )
    assert "payload->>'input_tokens'" in frag
    assert "usage_prompt_tokens" in frag
    assert "::numeric" in frag


def test_safe_cost_coalesce_ladder():
    frag = safe_cost_coalesce_sql("metrics", "payload", "attributes")
    assert frag.count("cost_usd") == 3
