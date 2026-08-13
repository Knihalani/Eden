"""Shutdown must be bounded, ordered, and complete.

Three separate failures lived in the lifespan's teardown.

**Unbounded.** All eight steps were bare ``await``s, each in its own ``try``.
One hung close — an aiohttp connector waiting on a dead socket, a Postgres pool
with an in-flight query — blocked the whole sequence until uvicorn's
``--timeout-graceful-shutdown`` expired and SIGKILLed the process. Everything
after the hang never ran, including the Postgres close and the background drain
that owns live billing rows. So a hang in a *cosmetic* step (say the OTel
exporter) destroyed data.

**Incomplete.** Eight ``close_*`` coroutines existed with no caller anywhere in
the repository: typesense, trace_store, kafka consumer and producer, ksql,
edge_fanout, hilt_controller, alert_processor. Each leaked its transports on
every pod restart while that subsystem was in use. Nothing failed, because
leaking a socket at process exit looks exactly like a clean exit.

**Unordered by accident.** The ordering comment said drains-then-sinks-then-
Postgres, but nothing enforced it, so a later edit could close the pool before
the drain that writes through it.

These tests pin all three properties. The completeness one is the important
one: it fails when someone adds a new ``close_*`` and forgets to register it,
which is exactly how the previous eight accumulated.
"""

from __future__ import annotations

import ast
import asyncio
from pathlib import Path

import pytest

from eden.api.app import _shutdown_step, _shutdown_steps

_SRC = Path(__file__).resolve().parents[3] / "src" / "eden"


def _names(*, background_workers: bool = True) -> list[str]:
    return [n for n, _, _ in _shutdown_steps(background_workers=background_workers)]


class TestBounded:
    @pytest.mark.asyncio
    async def test_a_hung_step_is_abandoned_not_awaited_forever(self) -> None:
        """The whole point: a hang must cost only itself."""
        started = asyncio.Event()

        async def _hang() -> None:
            started.set()
            await asyncio.sleep(3600)

        # A real timeout, small enough to keep the test fast.
        await asyncio.wait_for(
            _shutdown_step("hung", _hang, timeout=0.05), timeout=5.0
        )
        assert started.is_set(), "the step never ran"

    @pytest.mark.asyncio
    async def test_a_raising_step_does_not_propagate(self) -> None:
        async def _boom() -> None:
            raise RuntimeError("connector already closed")

        await _shutdown_step("boom", _boom, timeout=1.0)  # must not raise

    @pytest.mark.asyncio
    async def test_a_failing_import_does_not_propagate(self) -> None:
        """Factories import lazily; a missing optional dep must be survivable."""

        async def _bad_import() -> None:
            import eden.definitely_not_a_module  # noqa: F401

        await _shutdown_step("bad_import", _bad_import, timeout=1.0)

    @pytest.mark.asyncio
    async def test_a_step_after_a_hang_still_runs(self) -> None:
        """The failure mode that lost data: everything after the hang skipped.

        The whole loop is wrapped in an outer ``wait_for``. Without it, a
        regression that drops the per-step timeout makes this test *hang* rather
        than fail — verified by mutation: removing ``asyncio.wait_for`` from
        ``_shutdown_step`` blocked the pytest run past two minutes instead of
        reporting a failure. A guard that hangs CI instead of failing it is a
        guard people disable.
        """
        ran: list[str] = []

        async def _hang() -> None:
            await asyncio.sleep(3600)

        async def _later() -> None:
            ran.append("later")

        async def _run() -> None:
            for name, factory, timeout in (
                ("hung", _hang, 0.05),
                ("later", _later, 1.0),
            ):
                await _shutdown_step(name, factory, timeout)

        await asyncio.wait_for(_run(), timeout=10.0)
        assert ran == ["later"]

    def test_every_step_has_a_positive_timeout(self) -> None:
        for name, _factory, timeout in _shutdown_steps(background_workers=True):
            assert timeout > 0, f"{name} has a non-positive timeout"


class TestOrdering:
    def test_postgres_closes_last(self) -> None:
        """Earlier drains write through the pool."""
        assert _names()[-1] == "postgres"

    def test_drains_precede_the_pool_and_the_sinks(self) -> None:
        names = _names()
        for drain in ("background_workers", "trace_quality", "telemetry_collector"):
            assert names.index(drain) < names.index("postgres")
            assert names.index(drain) < names.index("redis")

    def test_background_workers_first_when_enabled(self) -> None:
        assert _names(background_workers=True)[0] == "background_workers"

    def test_background_workers_absent_when_disabled(self) -> None:
        names = _names(background_workers=False)
        assert "background_workers" not in names
        assert names[-1] == "postgres"

    def test_no_duplicate_steps(self) -> None:
        names = _names()
        assert len(names) == len(set(names))


class TestCompleteness:
    """Every module-level closer must be registered, or explicitly excused."""

    #: Closers deliberately not in the lifespan registry, with the reason.
    #: Anything added here needs a justification a reviewer would accept.
    _EXCUSED: dict[str, str] = {}

    @staticmethod
    def _declared_closers() -> dict[str, str]:
        """``{function_name: module_path}`` for every module-level closer."""
        found: dict[str, str] = {}
        for path in sorted(_SRC.rglob("*.py")):
            if "db_migrations" in path.parts:
                continue
            try:
                tree = ast.parse(path.read_text(encoding="utf-8"))
            except (OSError, SyntaxError):  # pragma: no cover
                continue
            for node in tree.body:  # module level only
                if isinstance(node, ast.AsyncFunctionDef) and (
                    node.name.startswith("close_")
                    or node.name.startswith("shutdown_")
                ):
                    found[node.name] = str(path.relative_to(_SRC))
        return found

    def test_the_scan_finds_the_known_closers(self) -> None:
        """Guards the guard — an empty scan would make the next test vacuous."""
        declared = self._declared_closers()
        assert "close_postgres_client" in declared
        assert "close_redis_client" in declared
        assert len(declared) >= 15, f"only found {len(declared)}"

    @staticmethod
    def _registered_closers() -> set[str]:
        """The closer *function names* each registry factory actually imports.

        Read from ``factory.__code__.co_names`` rather than guessed from the
        registry's human-readable label. An earlier version of this test matched
        label-to-function-name with a pile of suffix-stripping heuristics and
        produced a false positive on ``close_otel_dual_exporter`` vs the
        ``otel_exporter`` label. Bytecode names are exact, so the labels stay
        readable and the check stays honest.
        """
        names: set[str] = set()
        for _label, factory, _timeout in _shutdown_steps(background_workers=True):
            names.update(
                n
                for n in factory.__code__.co_names
                if n.startswith(("close_", "shutdown_", "stop_", "aclose"))
            )
        return names

    def test_the_introspection_finds_real_closer_names(self) -> None:
        """Guards the guard: an empty set would make the next test vacuous."""
        registered = self._registered_closers()
        assert "close_postgres_client" in registered
        assert "close_otel_dual_exporter" in registered
        assert len(registered) >= 15, f"only introspected {len(registered)}"

    def test_every_closer_is_registered(self) -> None:
        declared = self._declared_closers()
        registered = self._registered_closers()
        missing = sorted(
            f"{fn} ({module})"
            for fn, module in declared.items()
            if fn not in registered and fn not in self._EXCUSED
        )
        assert not missing, (
            "these closers exist but no shutdown step calls them, so their "
            "transports leak on every restart — register them in "
            f"_shutdown_steps or excuse them with a reason: {missing}"
        )

    def test_previously_orphaned_closers_are_now_registered(self) -> None:
        """The eight that had no caller at all. Named so a regression is obvious."""
        names = set(_names())
        for label in (
            "typesense_client",
            "trace_store",
            "kafka_consumer",
            "kafka_producer",
            # "ksql_client" removed 2026-08-12 (OOM W1-9 / A3): the dead
            # ksqlDB integration was deleted along with its shutdown entry.
            "edge_fanout",
            "hilt_controller",
            "alert_processor",
        ):
            assert label in names, f"{label} dropped out of the shutdown registry"
