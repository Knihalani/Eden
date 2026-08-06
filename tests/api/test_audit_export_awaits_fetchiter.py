"""Source-level assertions guarding the audit-log export endpoint.

Background
----------
``GET /{org_id}/audit-log/export`` (``export_audit_log`` in
``eden.api.routes.audit``) streams the audit log as JSONL or CSV
via ``client.fetchiter(...)``.

``fetchiter`` is declared ``async def`` *with* a ``yield`` inside
(``eden.storage.postgres.AsyncpgClient.fetchiter``), making it an
**async generator function** — calling ``client.fetchiter(...)``
returns an async generator object that the caller iterates with
``async for``.

Two foot-guns:

1. Adding ``await`` before ``client.fetchiter(...)`` raises
   ``TypeError: object async_generator can't be used in 'await'
   expression`` because async generators are not awaitables.

2. Using a ``%s`` placeholder instead of ``$1`` is inconsistent
   with the rest of the codebase (which uses asyncpg's ``$N``
   placeholders) and will fail at the asyncpg layer with a
   ``SyntaxError`` or runtime error depending on the driver
   binding.

This test asserts the call site stays in the documented shape.
"""

from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
AUDIT_ROUTE = REPO_ROOT / "src" / "eden" / "api" / "routes" / "audit.py"


def _body() -> str:
    return AUDIT_ROUTE.read_text(encoding="utf-8")


def _export_section(body: str) -> str:
    start = body.find("async def export_audit_log(")
    assert start != -1, "export_audit_log function not found"
    end = body.find("\n\n\n", start)
    if end == -1:
        end = body.find("@router", start + 1)
    return body[start:end if end != -1 else None]


def test_export_audit_log_does_not_await_fetchiter() -> None:
    """``rows = client.fetchiter(...)`` — never ``await``ed.

    ``fetchiter`` is an async generator; awaiting it raises
    ``TypeError: object async_generator can't be used in 'await'``.
    """
    section = _export_section(_body())
    assert "rows = await client.fetchiter(" not in section, (
        "audit-log export endpoint must NOT `await` client.fetchiter(...); "
        "fetchiter is an async generator (yield inside async def), so "
        "awaiting it raises `TypeError: object async_generator can't be "
        "used in 'await' expression`."
    )
    assert "rows = client.fetchiter(" in section, (
        "Expected `rows = client.fetchiter(...)` in "
        "eden.api.routes.audit.export_audit_log. Did the file get "
        "rewritten? The streaming export depends on this call."
    )


def test_export_audit_log_uses_dollar_placeholder() -> None:
    """Placeholder must be ``$1`` (asyncpg), not ``%s`` (DBAPI)."""
    section = _export_section(_body())
    assert "%s" not in section, (
        "audit-log export contains a `%s` placeholder; use `$1` to "
        "match the rest of the codebase (asyncpg convention)."
    )


def test_export_audit_log_queries_a_real_table() -> None:
    """FEAT-54 — ``audit_log`` is not a real table (only ``org_audit_log``
    exists, per ``001_initial_schema.py``). Guard against the export
    endpoint regressing back to the nonexistent table.
    """
    section = _export_section(_body())
    assert "FROM audit_log " not in section, (
        "audit-log export must not query the nonexistent `audit_log` "
        "table; use `org_audit_log` (see 001_initial_schema.py)."
    )
    assert "org_audit_log" in section, (
        "Expected the audit-log export to query `org_audit_log`, the "
        "real table backing the organization audit trail."
    )
    # `org_audit_log` has no `prev_hash`/`entry_hash` columns — those
    # hash-chain columns live on the unrelated `agent_audit_ledger`
    # table (092_market_ready_consolidated.py), and no migration
    # defines a `verify_audit_chain()` SQL function either.
    assert "prev_hash" not in section
    assert "entry_hash" not in section
