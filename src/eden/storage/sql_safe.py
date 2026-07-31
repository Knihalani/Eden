"""Safe SQL fragments for jsonb metric casts.

SDK / provider payloads often store token counts as JSON *numbers*
with a fractional part (``198.0``). Postgres ``->>'key'`` yields the
text ``'198.0'``, and ``::int`` then raises
``invalid input syntax for type integer`` — which historically 503'd
portal traces and emptied the agents list (metrics soft-fail).

Rule: never cast token text with bare ``::int``. Always
``NULLIF → ::numeric → (::int at the end)``. Cost may use ``::float``
after ``NULLIF`` (decimals are valid).
"""

from __future__ import annotations

# Per-field token expression. ``alias`` is ``"e."`` or ``""``.
# ``key`` is the jsonb key (input_tokens / output_tokens / …).
_SAFE_TOKEN_FIELD = "COALESCE((NULLIF({alias}{col}->>'{key}', ''))::numeric, 0)"


def safe_token_field(key: str, *, alias: str = "", col: str = "metrics") -> str:
    """Single jsonb token field → numeric (never bare ``::int``)."""
    return _SAFE_TOKEN_FIELD.format(alias=alias, col=col, key=key)


def safe_token_sum_sql(*, alias: str = "", col: str = "metrics") -> str:
    """SUM(input+output tokens) as int — portal list/detail shape."""
    inp = safe_token_field("input_tokens", alias=alias, col=col)
    out = safe_token_field("output_tokens", alias=alias, col=col)
    return f"COALESCE(SUM({inp} + {out}), 0)::int"


def safe_input_token_sum_sql(*, alias: str = "", col: str = "metrics") -> str:
    """SUM(input_tokens) as int."""
    return f"COALESCE(SUM({safe_token_field('input_tokens', alias=alias, col=col)}), 0)::int"


def safe_output_token_sum_sql(*, alias: str = "", col: str = "metrics") -> str:
    """SUM(output_tokens) as int."""
    return f"COALESCE(SUM({safe_token_field('output_tokens', alias=alias, col=col)}), 0)::int"


def safe_cost_sum_sql(*, alias: str = "", col: str = "metrics") -> str:
    """SUM(cost_usd) as float from one jsonb column.

    Coalesces to ``0`` when every row lacked a stamped cost — callers that
    estimate from tokens (trace list) should use this form.
    """
    return (
        "COALESCE(SUM("
        f"COALESCE((NULLIF({alias}{col}->>'cost_usd', ''))::float, 0)"
        "), 0)::float"
    )


def safe_cost_sum_nullable_sql(*, alias: str = "", col: str = "metrics") -> str:
    """SUM(cost_usd); SQL NULL when no event stamped cost_usd.

    Use for agent-card rollups so the portal can show ``—`` instead of
    inventing ``$0.00`` when cost was never recorded.
    """
    return f"SUM((NULLIF({alias}{col}->>'cost_usd', ''))::float)"


def safe_token_coalesce_sql(
    *sources: tuple[str, str],
    fallback: str | None = None,
) -> str:
    """Coalesce ladder for a single token total.

    Each ``sources`` entry is ``(column, key)`` e.g. ``("payload", "input_tokens")``.
    ``fallback`` is an optional already-numeric SQL expression
    (e.g. ``usage_prompt_tokens``).
    """
    parts: list[str] = []
    for col, key in sources:
        parts.append(f"(NULLIF({col}->>'{key}', ''))::numeric")
    if fallback:
        parts.append(fallback)
    parts.append("0")
    return "COALESCE(" + ", ".join(parts) + ")"


def safe_cost_coalesce_sql(*columns: str) -> str:
    """Coalesce ladder across metrics/payload/attributes cost_usd."""
    parts = [f"(NULLIF({c}->>'cost_usd', ''))::float" for c in columns]
    parts.append("0")
    return "COALESCE(" + ", ".join(parts) + ")"
