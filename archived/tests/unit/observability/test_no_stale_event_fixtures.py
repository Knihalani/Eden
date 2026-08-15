"""A test fixture with a hardcoded timestamp stops testing after 24 hours.

``TelemetryCollector.ingest`` runs the late-span policy, which returns
``reject`` for any event older than ``late_span_max_age_seconds`` (86400s by
default) and makes ``ingest`` return ``False`` before ``_route`` is reached.

So a fixture written with a literal date works on the day it is written and,
from the next day on, is silently rejected. Whether that shows up depends
entirely on what the test asserts:

* ``assert ok is True`` fails loudly the next day -- annoying, but honest.
* ``mock.assert_not_awaited()`` keeps passing *forever*, because a rejected
  event never reaches the thing being asserted about. The test stays green and
  stops testing anything.

The second kind is why this guard exists. ``test_a5_ingest_hot_path``'s
``test_ingest_does_not_flush_every_event`` had been in that state since
2026-07-19: it would have passed with the ClickHouse buffer flushing on every
single event, the exact regression it was written to prevent.

The rule enforced here: a literal event timestamp is fine when the event goes
straight to a helper that skips validation (``_route_redis``,
``_route_clickhouse``, ``_enrich``), and not fine when it can reach the
age-gated ``ingest`` / ``ingest_batch``. The two are distinguished with ``ast``
rather than by grepping whole files, because most modules legitimately do both.
"""

from __future__ import annotations

import ast
from pathlib import Path

_TESTS = Path(__file__).resolve().parents[2]
_SELF = Path(__file__).name

#: The age-gated entry points. Everything else on the collector is called
#: directly by tests and skips validation, so a fixed timestamp there is fine
#: and often clearer than a relative one.
_AGE_GATED = {"ingest", "ingest_batch"}


def _literal_ts_lines(node: ast.AST) -> list[int]:
    """Lines under ``node`` that pass a string literal as ``timestamp=``."""
    out: list[int] = []
    for sub in ast.walk(node):
        if not isinstance(sub, ast.Call):
            continue
        for kw in sub.keywords:
            if kw.arg != "timestamp":
                continue
            if isinstance(kw.value, ast.Constant) and isinstance(kw.value.value, str):
                out.append(kw.value.lineno)
    return out


def _calls_age_gated(node: ast.AST) -> bool:
    for sub in ast.walk(node):
        if (
            isinstance(sub, ast.Call)
            and isinstance(sub.func, ast.Attribute)
            and sub.func.attr in _AGE_GATED
        ):
            return True
    return False


def _offenders() -> list[str]:
    """``file:line`` for each literal timestamp reachable by an age-gated call.

    A literal inside a *module-level helper* counts when the module calls
    ``ingest`` anywhere, because the helper is shared and the call site is a
    different function. A literal inside a test function counts only when that
    same function calls ``ingest`` -- otherwise it is a direct-helper fixture.
    """
    found: list[str] = []
    for path in sorted(_TESTS.rglob("test_*.py")):
        if path.name == _SELF:
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except (OSError, SyntaxError):  # pragma: no cover
            continue

        module_uses_gate = _calls_age_gated(tree)
        if not module_uses_gate:
            continue

        rel = path.relative_to(_TESTS)
        for top in ast.walk(tree):
            if not isinstance(top, ast.FunctionDef | ast.AsyncFunctionDef):
                continue
            literals = _literal_ts_lines(top)
            if not literals:
                continue
            is_helper = not top.name.startswith("test_")
            if is_helper or _calls_age_gated(top):
                found.extend(f"{rel}:{line}" for line in literals)
    return sorted(set(found))


def test_no_ingest_reachable_fixture_pins_a_literal_timestamp() -> None:
    offenders = _offenders()
    assert not offenders, (
        "these fixtures pin a literal timestamp and can reach ingest(), so the "
        "late-span policy rejects them once they are older than "
        "late_span_max_age_seconds -- and an assertion like "
        "assert_not_awaited() then keeps passing while testing nothing. Use "
        f"datetime.now(UTC).isoformat(): {offenders}"
    )


class TestTheGuardWorks:
    """A guard that cannot fail is worse than no guard."""

    @staticmethod
    def _scan(source: str) -> list[str]:
        tree = ast.parse(source)
        if not _calls_age_gated(tree):
            return []
        out: list[str] = []
        for top in ast.walk(tree):
            if not isinstance(top, ast.FunctionDef | ast.AsyncFunctionDef):
                continue
            lits = _literal_ts_lines(top)
            if lits and (not top.name.startswith("test_") or _calls_age_gated(top)):
                out.extend(str(x) for x in lits)
        return out

    def test_flags_a_module_level_factory(self) -> None:
        src = (
            "def _event():\n"
            "    return TelemetryEvent(timestamp='2026-07-18T00:00:00Z')\n"
            "async def test_x(c):\n"
            "    await c.ingest(_event())\n"
        )
        assert self._scan(src) == ["2"]

    def test_flags_a_literal_inside_the_ingesting_test(self) -> None:
        src = (
            "async def test_x(c):\n"
            "    e = TelemetryEvent(timestamp='2026-07-18T00:00:00Z')\n"
            "    await c.ingest(e)\n"
        )
        assert self._scan(src) == ["2"]

    def test_ignores_a_literal_used_only_on_a_direct_helper(self) -> None:
        """``_route_redis`` skips validation -- a fixed date is fine there."""
        src = (
            "async def test_direct(c):\n"
            "    e = TelemetryEvent(timestamp='2026-06-27T00:00:00Z')\n"
            "    await c._route_redis(e)\n"
            "async def test_other(c):\n"
            "    await c.ingest(fresh())\n"
        )
        assert self._scan(src) == []

    def test_ignores_a_relative_timestamp(self) -> None:
        src = (
            "def _event():\n"
            "    return TelemetryEvent(timestamp=datetime.now(UTC).isoformat())\n"
            "async def test_x(c):\n"
            "    await c.ingest(_event())\n"
        )
        assert self._scan(src) == []

    def test_ignores_a_module_that_never_ingests(self) -> None:
        src = (
            "def _event():\n"
            "    return TelemetryEvent(timestamp='2024-01-01T00:00:00Z')\n"
            "def test_x():\n"
            "    assert _event().timestamp\n"
        )
        assert self._scan(src) == []
