"""Regression tests for F821 (undefined name) fixes — audit 2026-07-05.

These tests verify that modules with previously-missing imports or
undefined references now work end-to-end. They serve as a smoke test
that the import surface is consistent.

Pre-fix: ruff flagged several ``F821: undefined name`` errors in
modules where a runtime reference to a name was missing its import.
The modules would import fine, but only because the undefined name
was inside dead code — e.g. ``return _dependency`` after an
unconditional ``raise HTTPException``, or a ``logger.warning(...)
in an ``except`` block where ``logger`` wasn't imported.

Post-fix: dead code is removed, missing imports are added, and
each module is now import-clean.
"""

from __future__ import annotations

import importlib

import pytest


# Each tuple is (module_name, attribute) — the attribute should now be
# importable (or a known-side-effect call should succeed).
_REGRESSION_TARGETS: list[tuple[str, str]] = [
    # F821: missing imports that were silently used in dead code.
    ("eden.api.deps", "get_ingestion_auth"),  # had dead `return _dependency`
    ("eden.api.routes.sso", "router"),  # used status without import
    ("eden.api.routes.auth", "router"),  # dead code referencing access_token
    ("eden.code_change.auto_approval.dry_run", "AUTO_APPROVAL_DEFAULTS"),
    ("eden.data_platform.clickhouse_sink", "ClickHouseSink"),
    ("eden.llmops.production_monitor", "logger"),
    ("eden.optimization.cache", "ExactMatchCache"),
    ("eden.providers.pr", "_HTTPX"),
    ("eden.storage.dsn", "build_dsn"),
    ("eden.storage.postgres", "PostgresClient"),
    ("eden.workers.main", "main"),
]


@pytest.mark.parametrize("module_name,attribute", _REGRESSION_TARGETS)
def test_module_attribute_importable(module_name: str, attribute: str) -> None:
    """Each previously-broken module now exposes the expected attribute.

    A failure here means a refactor regressed the F821 fix.
    """
    module = importlib.import_module(module_name)
    assert hasattr(module, attribute), (
        f"{module_name}.{attribute} is missing — the F821 fix has "
        f"regressed. Either the import was lost or the dead code "
        f"that referenced the undefined name was re-introduced."
    )


def test_investigation_all_only_exports_existing_names() -> None:
    """Audit 2026-07-05: removed ``ReportGenerator`` and
    ``RecommendationEngine`` from ``__all__`` because they were
    F822 (undefined in ``__all__``) — the classes were folded into
    :class:`InvestigationAgent` per upgradespec §D.4."""
    import eden.autonomous.investigation as mod
    module_attrs = set(dir(mod))
    for name in mod.__all__:
        assert name in module_attrs, (
            f"eden.autonomous.investigation.__all__ references "
            f"{name!r} which is not defined on the module"
        )


def test_query_all_only_exports_existing_names() -> None:
    """``NLQueryEngine``, ``AutoDashboardBuilder``, and
    ``NLReportGenerator`` must all be defined when listed in
    ``__all__``."""
    import eden.autonomous.nl_interface.query as mod
    module_attrs = set(dir(mod))
    for name in mod.__all__:
        assert name in module_attrs, (
            f"eden.autonomous.nl_interface.query.__all__ references "
            f"{name!r} which is not defined on the module"
        )


def test_signup_dead_code_removed() -> None:
    """Audit 2026-07-05: the ``return UserResponse(...)`` tail in
    :func:`signup` was unreachable (after the 202 JSONResponse
    return) but referenced an undefined ``access_token``. The block
    was deleted; verify by AST-walking the function."""
    import ast
    from pathlib import Path
    src = Path("src/eden/api/routes/auth.py").read_text()
    tree = ast.parse(src)

    signup_fn = None
    for node in tree.body:
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "signup":
            signup_fn = node
            break
    assert signup_fn is not None, "signup function not found in auth.py"

    # Look for any reference to ``access_token`` in the function body.
    for sub in ast.walk(signup_fn):
        if isinstance(sub, ast.Name) and sub.id == "access_token":
            pytest.fail(
                "auth.signup() still references undefined "
                "'access_token' — the dead-code removal regressed"
            )

    # Look for ``return UserResponse(...)`` (the dead-code tail).
    for sub in ast.walk(signup_fn):
        if isinstance(sub, ast.Call):
            func = sub.func
            if isinstance(func, ast.Name) and func.id == "UserResponse":
                # Found a UserResponse() call — must be in unreachable
                # code (none, post-fix).
                pytest.fail(
                    "auth.signup() still has a 'return UserResponse(...)' "
                    "call — the dead-code removal regressed"
                )


def test_dsn_module_no_dangling_block_after_return() -> None:
    """Audit 2026-07-05: removed the trailing ``if settings.postgres_sslmode:``
    block in :func:`_translate_sslmode_to_asyncpg_ssl` that referenced
    ``settings`` and ``base`` from a different function (dead code
    after the function's actual ``return``)."""
    import ast
    from pathlib import Path
    src = Path("src/eden/storage/dsn.py").read_text()
    tree = ast.parse(src)

    for node in tree.body:
        if (
            isinstance(node, ast.FunctionDef)
            and node.name == "_translate_sslmode_to_asyncpg_ssl"
        ):
            last_stmt = node.body[-1]
            assert isinstance(last_stmt, ast.Return), (
                "_translate_sslmode_to_asyncpg_ssl must end with a "
                "return statement (the dead code that followed the "
                "real return has been re-introduced)"
            )
            break
    else:
        pytest.fail("_translate_sslmode_to_asyncpg_ssl not found")


def test_dry_run_no_string_policy_guard() -> None:
    """Audit 2026-07-05: replaced the nonsensical
    ``{**AUTO_APPROVAL_DEFAULTS, **policy} if 'policy' in dir() else AUTO_APPROVAL_DEFAULTS``
    with a direct ``AUTO_APPROVAL_DEFAULTS`` reference. The runtime
    was always using defaults (the local ``policy`` variable never
    existed), so this is a no-op behavior change but a real code
    clarity win."""
    import ast
    from pathlib import Path
    src = Path("src/eden/code_change/auto_approval/dry_run.py").read_text()
    # The old string-comparison hack should be gone.
    assert '"policy" in dir()' not in src, (
        "dry_run.py still contains the unreachable 'policy' in dir() "
        "guard — F821 regressed"
    )


def test_test_runner_no_undefined_sandboxspec_type() -> None:
    """Audit 2026-07-05: changed ``spec: SandboxSpec | None = None``
    in :meth:`TestPlanRunner.run` to ``spec: Any | None = None``
    because ``SandboxSpec`` was never imported (the sandbox
    subsystem was retired 2026-07-04)."""
    import ast
    from pathlib import Path
    src = Path("src/eden/code_change/test_runner.py").read_text()
    tree = ast.parse(src)
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.arg)
            and node.arg == "spec"
        ):
            ann = node.annotation
            if (
                isinstance(ann, ast.BinOp)
                and isinstance(ann.left, ast.Name)
                and ann.left.id == "SandboxSpec"
            ):
                pytest.fail(
                    "TestPlanRunner.run still types `spec` as "
                    "SandboxSpec | None — SandboxSpec was removed "
                    "when the sandbox subsystem retired"
                )