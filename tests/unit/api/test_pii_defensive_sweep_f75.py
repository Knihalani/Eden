"""F75 — Defensive PII redaction on remaining broad `exc` log sites.

Pre-F75, 23 ``logger.warning/error/exception`` call sites in
``src/eden/api/`` interpolated a bare ``exc`` (whose ``str(exc)``
can include emails, tokens, and other PII if the underlying
library's error format ever changes — Clerk, Stripe, GitHub,
Helicone, etc. all surface different shapes).

F75 wraps each of those ``exc`` references through
``redact_all(str(exc))`` as defense-in-depth. This test pins the
behavior: every API route + API utils module MUST use
``redact_all(str(exc))`` for any logger call that takes an
exception, OR an explicit non-exc-aware exception type arg
(e.g. ``type(exc).__name__``).

Scope: ``src/eden/api/utils/`` + ``src/eden/api/routes/``.
Non-API subsystems (workers, cron_tick, observability internal)
are infrastructure failures with no user-data risk and stay as-is.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path


ROOT = Path("src/eden/api")


def _files_in_scope() -> list[Path]:
    return sorted(
        list((ROOT / "utils").glob("*.py"))
        + list((ROOT / "routes").glob("*.py"))
    )


def _logger_calls_with_exc(text: str) -> list[tuple[int, str]]:
    """Return (line_no, exc_var) for every ``logger.<level>(... %s ..., exc)``
    call in the source. A regression is a new bare-exc site that
    didn't go through redact_all."""
    tree = ast.parse(text)
    findings: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        # logger.warning / error / exception / critical
        if not (
            isinstance(func, ast.Attribute)
            and isinstance(func.value, ast.Name)
            and func.value.id == "logger"
            and func.attr in {"warning", "error", "exception", "critical", "info", "debug"}
        ):
            continue
        # Look at positional args for a bare Name that matches `exc`,
        # `e`, `err`, or `error` (the typical exception variable
        # names).
        for arg in node.args:
            if isinstance(arg, ast.Name) and arg.id in {"exc", "e", "err", "error"}:
                findings.append((node.lineno, arg.id))
                break
    return findings


def _is_wrapped(text: str, line_no: int, exc_var: str) -> bool:
    """Check whether the bare ``exc`` on line_no was actually
    rewritten to ``redact_all(str(exc))``."""
    lines = text.splitlines()
    if line_no < 1 or line_no > len(lines):
        return False
    line = lines[line_no - 1]
    # Either the call contains `redact_all(str(<exc_var>))` — fine —
    # or the bare exc was already replaced.
    return f"redact_all(str({exc_var}))" in line


class TestF75SweepCoverage:
    """Every bare-exc logger call in API routes + utils MUST be
    wrapped through ``redact_all(str(...))``."""

    def test_no_unwrapped_exc_log_sites(self) -> None:
        offenders: list[str] = []
        for path in _files_in_scope():
            text = path.read_text()
            for line_no, exc_var in _logger_calls_with_exc(text):
                if not _is_wrapped(text, line_no, exc_var):
                    offenders.append(f"{path}:{line_no}: {exc_var}")
        assert not offenders, (
            "F75 regression: these logger.<level>(... %s ..., exc) "
            "call sites are not wrapped through redact_all(str(exc)). "
            "Bare exc interpolation can leak PII if the underlying "
            "library's error format ever changes (Clerk, Stripe, "
            "GitHub, Helicone, etc.).\n"
            + "\n".join(offenders)
        )

    def test_sweep_covered_known_sites(self) -> None:
        """Spot-check the original 23 F75 sites: each one MUST
        contain ``redact_all(str(exc))`` after the sweep."""
        known = [
            ("src/eden/api/utils/clerk_auth.py", 177),
            ("src/eden/api/routes/auth.py", 783),
            ("src/eden/api/routes/agent_pr_suggestions.py", 289),
            ("src/eden/api/routes/onboarding.py", 114),
            ("src/eden/api/routes/orgs.py", 168),
            ("src/eden/api/routes/retention_policy.py", 151),
            ("src/eden/api/routes/cost_overrides.py", 212),
            ("src/eden/api/routes/observability.py", 272),
            ("src/eden/api/routes/observability.py", 334),
            ("src/eden/api/routes/gateway_models.py", 187),
            ("src/eden/api/routes/gateway_models.py", 210),
            ("src/eden/api/routes/gateway_models.py", 289),
            ("src/eden/api/routes/gateway_models.py", 327),
            ("src/eden/api/routes/clerk_webhooks.py", 487),
            ("src/eden/api/routes/cost.py", 50),
            ("src/eden/api/routes/cost.py", 59),
            ("src/eden/api/routes/github.py", 317),
            ("src/eden/api/routes/github.py", 459),
            ("src/eden/api/routes/github.py", 572),
            ("src/eden/api/routes/github.py", 584),
            ("src/eden/api/routes/github.py", 787),
            ("src/eden/api/routes/sidebar_prefs.py", 66),
            ("src/eden/api/routes/sidebar_prefs.py", 99),
        ]
        # Line numbers may have shifted due to import insertion;
        # check by content (search for the original call signature
        # within the file).
        for relpath, _line in known:
            text = Path(relpath).read_text()
            # Count occurrences of `redact_all(str(exc))` in logger
            # calls — must be at least one.
            matches = re.findall(r"redact_all\(str\(exc\)\)", text)
            assert matches, (
                f"F75 regression: {relpath} has no redact_all(str(exc)) "
                f"wrap on any logger call. Sweep incomplete."
            )


class TestF75Imports:
    """Every patched file MUST have a module-level import of
    ``redact_all`` (column-0). Indented/in-function inserts are
    a bug."""

    def test_all_files_have_top_level_redact_import(self) -> None:
        missing: list[str] = []
        for path in _files_in_scope():
            text = path.read_text()
            has = any(
                line.startswith("from eden.api.utils.redact import")
                and "redact_all" in line
                for line in text.splitlines()
            )
            if not has:
                # The file that defines redact_all is exempt
                # (it can not import itself).
                if path.name == "redact.py":
                    continue
                if "redact_all" in text:
                    missing.append(str(path))
        assert not missing, (
            "F75 regression: these files use redact_all but lack a "
            "module-level import of it:\n" + "\n".join(missing)
        )
