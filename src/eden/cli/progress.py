"""CLI progress helpers.

Phase 5.3.4: rich-ish progress display without taking on a heavyweight
dependency like ``rich`` or ``tqdm``. Renders a stage-by-stage pipeline
progress bar in the terminal, with a spinner for the active stage.

Used by ``eden job watch`` and any other long-running command.
"""

from __future__ import annotations

import itertools
import sys
import threading
import time
from typing import Iterable, Optional

# Canonical Eden pipeline stage order (matches EdenJobState.current_stage
# values produced by the LangGraph pipeline).
PIPELINE_STAGES = [
    "planning",
    "criticizing",
    "refining",
    "fact_checking",
    "executing",
    "code_quality",
    "verifying",
    "testing",
    "archiving",
]


def stage_index(stage: Optional[str]) -> int:
    """Return the index of ``stage`` in :data:`PIPELINE_STAGES`, or -1."""
    if not stage:
        return -1
    try:
        return PIPELINE_STAGES.index(stage)
    except ValueError:
        return -1


class StageProgress:
    """Thread-safe single-line progress display for pipeline stages.

    Renders a bar like:

        [██████░░░░] verifying  (6/9)

    and a spinner for the active stage when ``spin=True``. Falls back
    to a plain ``click.echo`` when the output is not a TTY.
    """

    SPINNER_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"

    def __init__(
        self,
        stages: Iterable[str] = PIPELINE_STAGES,
        *,
        spin: bool = True,
        isatty: bool = True,
    ) -> None:
        self.stages = list(stages)
        self.spin = spin
        self.isatty = isatty and sys.stdout.isatty()
        self._current = -1
        self._status: Optional[str] = None
        self._done = False
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()

    def update(self, stage: str, status: Optional[str] = None) -> None:
        """Update the current stage (and optional status message)."""
        with self._lock:
            self._current = stage_index(stage)
            self._status = status

    def finish(self, status: Optional[str] = None) -> None:
        """Mark the run as complete and stop the spinner."""
        with self._lock:
            self._done = True
            if status:
                self._status = status
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=1.0)
        # Final print to TTY so the last state is visible after the cursor moves on
        if self.isatty:
            sys.stdout.write("\n")
            sys.stdout.flush()

    def start(self) -> None:
        """Start the background spinner (only on TTY)."""
        if not self.isatty:
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._spin_loop, daemon=True, name="cli-progress"
        )
        self._thread.start()

    def _spin_loop(self) -> None:
        assert self._thread is not None
        for frame in itertools.cycle(self.SPINNER_FRAMES):
            if self._stop.is_set():
                return
            with self._lock:
                line = self._render(frame)
            sys.stdout.write("\r" + line)
            sys.stdout.flush()
            time.sleep(0.1)

    def _render(self, spinner_frame: str = "") -> str:
        total = len(self.stages)
        if total == 0:
            return ""
        idx = max(0, self._current) if self._current >= 0 else 0
        pct = (idx + 1) / total if not self._done else 1.0
        filled = int(round(pct * 20))
        bar = "█" * filled + "░" * (20 - filled)
        current = self.stages[idx] if 0 <= idx < total else "-"
        if self._done:
            tag = "✓ done"
        elif self.spin and spinner_frame:
            tag = f"{spinner_frame} {current}"
        else:
            tag = current
        line = f"[{bar}] {tag}  ({idx + 1}/{total})"
        if self._status:
            line += f"  {self._status}"
        return line

    def echo(self, message: str) -> None:
        """Print a status line (e.g. ``→ stage change``) above the bar."""
        if self.isatty:
            # Clear the current spinner line, print, then re-render
            sys.stdout.write("\r" + " " * 80 + "\r")
            sys.stdout.write(message + "\n")
            with self._lock:
                sys.stdout.write(self._render())
            sys.stdout.flush()
        else:
            sys.stdout.write(message + "\n")
            sys.stdout.flush()
