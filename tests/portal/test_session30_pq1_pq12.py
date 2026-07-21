"""Session 30 tests — Portal quality (PQ-1..PQ-3, PQ-5, PQ-6, PQ-12).

Six audit items:

* **PQ-1** — ``optimization/budget/page.tsx`` must not use raw
  ``setInterval``; polling is via React Query ``refetchInterval``
  (supersedes the earlier ``usePolling`` swap).
* **PQ-2** — First-event wait surface must not use raw
  ``setInterval`` (``WaitingForFirstEvent`` is CTA-driven; the old
  ``onboarding/_steps/wait.tsx`` poller is gone).
* **PQ-3** — ``components/ai-insights/ChatSidebar.tsx`` drops the
  dead ``eventSourceRef``, adds an ``AbortController``, passes
  ``signal`` to POST, and ``reader.cancel()`` on abort.
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
    """``optimization/budget/page.tsx`` polls via React Query, not
    raw ``setInterval``.
    """

    def test_no_raw_setInterval(self) -> None:
        source = _read(
            "src/app/(portal)/optimization/budget/page.tsx"
        )
        assert "setInterval" not in source, (
            "PQ-1 regression: budget page still uses raw setInterval "
            "(should poll via React Query refetchInterval)"
        )

    def test_calls_use_polling(self) -> None:
        """Budget refresh uses ``refetchInterval`` on ``useOrgQuery``
        (React Query pauses when the tab is hidden).
        """
        source = _read(
            "src/app/(portal)/optimization/budget/page.tsx"
        )
        assert "refetchInterval" in source, (
            "PQ-1 regression: budget page must poll via "
            "React Query refetchInterval"
        )
        assert "useOrgQuery" in source, (
            "PQ-1 regression: budget page must load via useOrgQuery"
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
    """ChatSidebar stream cancel lives in ``useChatSidebar`` (W20 split).

    The dead ``eventSourceRef`` must stay gone; AbortController +
    abortRef + signal + reader.cancel remain on the stream hook.
    """

    _HOOK = "src/components/ai-insights/hooks/useChatSidebar.ts"
    _SHELL = "src/components/ai-insights/ChatSidebar.tsx"

    def test_no_event_source_ref(self) -> None:
        """The dead ``eventSourceRef`` must be gone from shell + hook."""
        for path in (self._SHELL, self._HOOK):
            source = _read(path)
            assert "eventSourceRef" not in source, (
                "PQ-3 regression: dead eventSourceRef must be removed "
                f"({path})"
            )

    def test_has_abort_controller(self) -> None:
        """An ``AbortController`` is created per submit() and
        installed in the ``abortRef`` slot."""
        source = _read(self._HOOK)
        assert "AbortController" in source, (
            "PQ-3 regression: useChatSidebar must construct an AbortController"
        )
        assert "abortRef" in source, (
            "PQ-3 regression: useChatSidebar must hold an abortRef"
        )

    def test_signal_passed_to_fetch(self) -> None:
        """The fetch() call carries the controller's signal so an
        unmount can cancel it."""
        source = _read(self._HOOK)
        assert "signal: controller.signal" in source, (
            "PQ-3 regression: fetch() must pass controller.signal"
        )

    def test_reader_cancel_on_abort(self) -> None:
        """The inner reader loop cancels its read on abort so the
        half-drained stream isn't flushed as garbage events."""
        source = _read(self._HOOK)
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
