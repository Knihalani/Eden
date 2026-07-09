"""Regression test for the July 2026 prompt-canary error-redaction fix.

``create_canary``, ``promote_canary``, ``rollback_canary`` previously
echoed the raw exception ``str(exc)`` in their 500 bodies::

    raise HTTPException(status_code=500, detail=str(exc)) from exc

Where ``exc`` could be::

    asyncpg.exceptions.UniqueViolationError:
      duplicate key value violates unique constraint
      "prompt_canary_experiments_experiment_id_key"
      DETAIL:  Key (experiment_id)=(d3b...) already exists.

That leaks the table name, the constraint name, and the partial UUID
to anyone who can hit the endpoint. Internal schema details don't
belong in 500 responses.

Fix: redacted via ``_safe_detail``. This test asserts the helper
doesn't echo back the original exception text.
"""

from __future__ import annotations

from eden.api.utils.safe_error import safe_detail as _safe_detail


def test_safe_detail_does_not_leak_table_name():
    exc = Exception(
        'duplicate key value violates unique constraint '
        '"prompt_canary_experiments_experiment_id_key" '
        'DETAIL: Key (experiment_id)=(d3bca4e2-3f8a) already exists.'
    )
    out = _safe_detail(exc)
    assert "prompt_canary_experiments" not in out
    assert "experiment_id_key" not in out
    assert "d3bca4e2" not in out


def test_safe_detail_does_not_leak_constraint_definitions():
    exc = Exception(
        'null value in column "tenant_id" violates not-null constraint'
    )
    out = _safe_detail(exc)
    assert "tenant_id" not in out
    assert "not-null constraint" not in out


def test_safe_detail_returns_a_safe_string():
    out = _safe_detail(RuntimeError("anything goes"))
    assert isinstance(out, str)
    assert len(out) > 0
    # Must not echo the raw exception.
    assert "anything" not in out
