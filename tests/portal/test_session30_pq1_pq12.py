"""Session 30 tests — Portal quality (PQ-1..PQ-3, PQ-5, PQ-6, PQ-12).

Six audit items:

* **PQ-1** — the budget/spend surface must not use raw
  ``setInterval``; refresh is React Query driven (supersedes the
  earlier ``usePolling`` swap). The ``optimization/`` route group
  is gone — the surface is now ``(portal)/cost/page.tsx``.
* **PQ-2** — First-event wait surface must not use raw
  ``setInterval`` (``WaitingForFirstEvent`` is CTA-driven; the old
  ``onboarding/_steps/wait.tsx`` poller is gone).
* **PQ-3** — the AI chat surface drops the dead ``eventSourceRef``,
  adds an ``AbortController``, passes ``signal`` to POST, and
  ``reader.cancel()`` on abort. ``components/ai-insights/`` was
  replaced by the ``(portal)/agent`` page, which now owns the
  stream loop.
* **PQ-5** — ``hooks/use-observability-stream.ts`` captures
  ``onError`` via a ref so the ``connect()`` dep array stays
  stable (no EventSource tear-down on every render).
* **PQ-6** — Same hook stops the reconnect loop after
  ``MAX_RECONNECT_ATTEMPTS`` (default 6) and closes the source.
* **PQ-12** — ``hooks/use-polling.ts`` fires an optional
  ``onAuthError(err)`` callback when the hook permanently bails
  on a 401/403 — previously silent.
"""

from __future__ import annotations

from pathlib import Path

import pytest

_PORTAL_ROOT = Path(__file__).parent.parent.parent / "clients/portal"


def _read(rel: str) -> str:
    raw = (_PORTAL_ROOT / rel).read_text()
    # Strip ``//`` line comments — the audit-fix comments mention
    # the literal ``setInterval`` / ``eventSourceRef`` in prose.
    return "\n".join(
        line for line in raw.splitlines()
        if not line.lstrip().startswith("//")
    )


# ─── PQ-1 + PQ-2 — setInterval → usePolling ─────────────────────


class TestBudgetPageUsesPolling:
    """The budget/spend surface refreshes via React Query, not raw
    ``setInterval``.

    ``optimization/budget/page.tsx`` is gone; budget rollup now
    renders on ``(portal)/cost/page.tsx`` (``budgetApi.get`` behind
    ``useOrgQuery``).
    """

    _BUDGET = "src/app/(portal)/cost/page.tsx"

    def test_no_raw_setInterval(self) -> None:
        source = _read(self._BUDGET)
        assert "setInterval" not in source, (
            "PQ-1 regression: cost/budget page still uses raw setInterval "
            "(should refresh via React Query refetchInterval)"
        )

    def test_calls_use_polling(self) -> None:
        """Budget data loads through ``useOrgQuery``; any recurring
        refresh must be React Query's ``refetchInterval`` (which
        pauses when the tab is hidden) rather than a hand-rolled
        timer.

        The cost page currently does *not* auto-refresh at all — it
        refetches on mount and on the error-state retry button. That
        is strictly cheaper than polling, so the guard enforces the
        conditional: no timer, and if a recurring refresh is ever
        added it has to be ``refetchInterval``.
        """
        source = _read(self._BUDGET)
        assert "useOrgQuery" in source, (
            "PQ-1 regression: budget/cost page must load via useOrgQuery"
        )
        for timer in ("setInterval", "setTimeout("):
            assert timer not in source, (
                f"PQ-1 regression: budget/cost page must not use {timer} "
                "to refresh — use React Query refetchInterval"
            )


class TestOnboardingWaitUsesPolling:
    """First-event wait is CTA-driven (no background poller).

    The old ``onboarding/_steps/wait.tsx`` ``usePolling`` surface was
    replaced by ``WaitingForFirstEvent`` — still must not reintroduce
    raw ``setInterval``.
    """

    _WAIT = "src/components/onboarding/WaitingForFirstEvent.tsx"

    def test_no_raw_setInterval(self) -> None:
        path = _PORTAL_ROOT / self._WAIT
        if not path.is_file():
            pytest.skip("WaitingForFirstEvent removed; PQ-2 surface N/A")
        source = _read(self._WAIT)
        assert "setInterval" not in source, (
            "PQ-2 regression: WaitingForFirstEvent still uses raw "
            "setInterval (must stay CTA-driven / no background poll)"
        )

    def test_calls_use_polling(self) -> None:
        """Wait surface is manual ``onCheck`` — no ``usePolling`` /
        ``setInterval`` poller.
        """
        path = _PORTAL_ROOT / self._WAIT
        if not path.is_file():
            pytest.skip("WaitingForFirstEvent removed; PQ-2 surface N/A")
        source = _read(self._WAIT)
        assert "usePolling" not in source, (
            "PQ-2 regression: WaitingForFirstEvent must not poll via "
            "usePolling (CTA onCheck is intentional)"
        )
        assert "onCheck" in source, (
            "PQ-2 regression: WaitingForFirstEvent must expose onCheck"
        )


# ─── PQ-3 — ChatSidebar AbortController + drop dead ref ────────


class TestChatSidebarAbortController:
    """AI chat stream cancel.

    ``components/ai-insights/{ChatSidebar.tsx,hooks/useChatSidebar.ts}``
    were removed when the assistant became a full page; the stream
    loop (and therefore this invariant) now lives in
    ``(portal)/agent/page.tsx``. The dead ``eventSourceRef`` must stay
    gone; AbortController + abortRef + signal + reader.cancel remain.
    """

    _CHAT = "src/app/(portal)/agent/page.tsx"

    def test_no_event_source_ref(self) -> None:
        """The dead ``eventSourceRef`` must be gone."""
        source = _read(self._CHAT)
        assert "eventSourceRef" not in source, (
            "PQ-3 regression: dead eventSourceRef must be removed "
            f"({self._CHAT})"
        )

    def test_has_abort_controller(self) -> None:
        """An ``AbortController`` is created per submit and installed
        in the ``abortRef`` slot."""
        source = _read(self._CHAT)
        assert "AbortController" in source, (
            "PQ-3 regression: agent chat must construct an AbortController"
        )
        assert "abortRef" in source, (
            "PQ-3 regression: agent chat must hold an abortRef"
        )

    def test_signal_passed_to_fetch(self) -> None:
        """The request carries the controller's signal so an unmount /
        thread switch can cancel it."""
        source = _read(self._CHAT)
        assert "signal: controller.signal" in source, (
            "PQ-3 regression: chat request must pass controller.signal"
        )

    def test_reader_cancel_on_abort(self) -> None:
        """The reader loop bails on abort and cancels the reader so the
        half-drained stream isn't flushed as garbage events and the
        upstream connection is released immediately."""
        source = _read(self._CHAT)
        assert "reader.cancel" in source, (
            "PQ-3 regression: must call reader.cancel() on abort"
        )
        assert "controller.signal.aborted" in source, (
            "PQ-3 regression: must check controller.signal.aborted"
        )


# ─── PQ-5 + PQ-6 — use-observability-stream stability ──────────


class TestObservabilityStreamOnErrorRef:
    """``onError`` is captured via ref so the ``connect`` callback
    doesn't tear down the EventSource on every render.
    """

    def test_uses_on_error_ref(self) -> None:
        source = _read("src/hooks/use-observability-stream.ts")
        assert "onErrorRef" in source, (
            "PQ-5 regression: onError must be captured via a ref"
        )

    def test_connect_dep_array_no_on_error(self) -> None:
        """The ``connect`` ``useCallback`` dep array must NOT list
        ``onError`` (the ref pattern removes the variable from the
        closure's identity).
        """
        source = _read("src/hooks/use-observability-stream.ts")
        # The dep array is the second-to-last bracket of the connect
        # useCallback. Find it via the closing pattern.
        start = source.index("const connect = React.useCallback")
        end = source.index("}, [", start)
        dep_array = source[end:end + 200].split("]", 1)[0] + "]"
        assert "onError" not in dep_array, (
            "PQ-5 regression: connect's dep array must NOT include "
            "onError (it's read via onErrorRef.current instead)"
        )


class TestObservabilityStreamMaxAttempts:
    """After ``MAX_RECONNECT_ATTEMPTS`` (default 6) the hook stops
    the reconnect loop and closes the source.
    """

    def test_max_reconnect_attempts_constant(self) -> None:
        source = _read("src/hooks/use-observability-stream.ts")
        assert "MAX_RECONNECT_ATTEMPTS" in source, (
            "PQ-6 regression: must declare MAX_RECONNECT_ATTEMPTS"
        )

    def test_caps_attempts(self) -> None:
        """The cap is enforced (``Math.min(reconnectAttemptsRef.current + 1,
        MAX_RECONNECT_ATTEMPTS)``) — post-cap the source is closed.
        """
        source = _read("src/hooks/use-observability-stream.ts")
        assert (
            "Math.min(\n        reconnectAttemptsRef.current + 1,\n        MAX_RECONNECT_ATTEMPTS,"
        ) in source, (
            "PQ-6 regression: reconnect attempts must be capped via Math.min"
        )
        # Hard stop when the cap is reached.
        assert "source.close()" in source, (
            "PQ-6 regression: source must be closed when the cap is hit"
        )


# ─── PQ-12 — use-polling surfaces 401-bail via callback ────────


class TestUsePollingAuthErrorCallback:
    """``usePolling`` accepts an optional ``onAuthError`` callback
    fired on the 401/403 permanent bail.
    """

    def test_on_auth_error_in_options(self) -> None:
        source = _read("src/hooks/use-polling.ts")
        assert "onAuthError" in source, (
            "PQ-12 regression: usePolling options must include onAuthError"
        )

    def test_callback_fired_on_bail(self) -> None:
        """The bail branch calls ``onAuthError?.(err)`` so callers
        can show the user-visible "session expired" surface.
        """
        source = _read("src/hooks/use-polling.ts")
        assert "onAuthError?.(err)" in source, (
            "PQ-12 regression: bail branch must invoke onAuthError?.(err)"
        )


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v", "--tb=short"]))
