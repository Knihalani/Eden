"""eden-debugger — local fixture replay (OOM plan §9.2 / W2-9).

Load an ``eden-failure-fixture-v1`` JSON file exported from the Eden portal
or MCP ``export_fixture`` tool, then either:

* **dry-run** (default): step through recorded traces/spans and print each
  span's name plus its recorded input and output attributes.

* **target mode** (``--target module:function``): call the user-supplied
  function with each span's recorded inputs, compare the actual return
  value to the recorded output, and report divergences.

Exit codes
----------
0 — all spans replayed without divergences (or dry-run completed).
1 — one or more divergences detected, or fixture/import error.
"""

from __future__ import annotations

import argparse
import importlib
import json
import sys
from pathlib import Path
from typing import Any, Callable

_FORMAT = "eden-failure-fixture-v1"


# ---------------------------------------------------------------------------
# Public exception
# ---------------------------------------------------------------------------


class FixtureError(ValueError):
    """Raised when a fixture file is unreadable or has an unexpected format."""


# ---------------------------------------------------------------------------
# Fixture loading
# ---------------------------------------------------------------------------


def load_fixture(path: str | Path) -> dict[str, Any]:
    """Load and minimally validate an eden failure fixture file.

    Parameters
    ----------
    path:
        Path to a ``.json`` file produced by the Eden portal export or MCP
        ``export_fixture`` tool.

    Returns
    -------
    dict
        The parsed fixture object (``format``, ``issue``, ``traces``, …).

    Raises
    ------
    FixtureError
        On missing file, JSON parse error, or unexpected ``format`` field.
    """
    p = Path(path)
    try:
        text = p.read_text(encoding="utf-8")
    except OSError as exc:
        raise FixtureError(f"Cannot read fixture file {str(path)!r}: {exc}") from exc
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise FixtureError(f"Invalid JSON in {str(path)!r}: {exc}") from exc
    if not isinstance(data, dict):
        raise FixtureError(
            f"Fixture root must be a JSON object, got {type(data).__name__}"
        )
    fmt = data.get("format")
    if fmt != _FORMAT:
        raise FixtureError(
            f"Expected format={_FORMAT!r}, got {fmt!r}. "
            "Re-export a fresh fixture from the Eden portal (portal → issue detail "
            "→ Export fixture) or via the MCP export_fixture tool."
        )
    return data


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _extract_io(attributes: dict[str, Any]) -> tuple[Any, Any]:
    """Heuristic: pull the first recognised input/output key from a span's
    attribute map.  Returns ``(input, output)``; either may be ``None``.
    """
    inp = (
        attributes.get("input")
        or attributes.get("gen_ai.input")
        or attributes.get("llm.input")
        or attributes.get("tool.input")
    )
    out = (
        attributes.get("output")
        or attributes.get("gen_ai.output")
        or attributes.get("llm.output")
        or attributes.get("tool.output")
        or attributes.get("result")
    )
    return inp, out


def _resolve_target(target_spec: str) -> Callable[..., Any]:
    """Import and return the callable named by ``"module:function"``."""
    if ":" not in target_spec:
        raise FixtureError(
            f"--target must be in module:function notation, got {target_spec!r}"
        )
    module_path, fn_name = target_spec.rsplit(":", 1)
    try:
        mod = importlib.import_module(module_path)
    except ImportError as exc:
        raise FixtureError(
            f"Cannot import module {module_path!r}: {exc}"
        ) from exc
    try:
        fn = getattr(mod, fn_name)
    except AttributeError:
        raise FixtureError(
            f"Module {module_path!r} has no attribute {fn_name!r}"
        )
    if not callable(fn):
        raise FixtureError(f"{target_spec!r} is not callable")
    return fn  # type: ignore[return-value]


def _truncate(s: str, n: int = 120) -> str:
    return s if len(s) <= n else s[:n] + "…"


def _json_repr(v: Any) -> str:
    try:
        return json.dumps(v)
    except Exception:
        return repr(v)


# ---------------------------------------------------------------------------
# Replay result
# ---------------------------------------------------------------------------


class ReplayResult:
    """Returned by :func:`replay_fixture`; carries divergence details."""

    def __init__(self) -> None:
        self.span_count: int = 0
        self.divergences: list[dict[str, Any]] = []

    @property
    def ok(self) -> bool:
        """``True`` when no divergences were detected."""
        return len(self.divergences) == 0


# ---------------------------------------------------------------------------
# Core replay logic
# ---------------------------------------------------------------------------


def replay_fixture(
    fixture: dict[str, Any],
    *,
    target_fn: Callable[..., Any] | None = None,
    verbose: bool = True,
) -> ReplayResult:
    """Replay the spans in *fixture*.

    Parameters
    ----------
    fixture:
        Parsed fixture dict (as returned by :func:`load_fixture`).
    target_fn:
        Optional callable.  When supplied, each span with a recorded input
        is passed to the function; its actual return value is compared to
        the recorded output and differences are recorded as divergences.
        When ``None`` the replay is a dry-run — no code is executed, spans
        are just printed.
    verbose:
        Print per-span output.  Set to ``False`` for quiet / machine use.

    Returns
    -------
    ReplayResult
        ``result.ok`` is ``True`` when ``result.divergences`` is empty.
    """
    result = ReplayResult()
    issue = fixture.get("issue") or {}
    traces = fixture.get("traces") or []

    if verbose:
        mode = "target" if target_fn is not None else "dry-run"
        print(f"Format:  {fixture.get('format')}")
        print(f"Exported:{fixture.get('exported_at', 'unknown')}")
        print(f"Issue:   {issue.get('id', '?')}  {issue.get('title', '')}")
        print(f"Traces:  {len(traces)}   Mode: {mode}")
        print()

    for t_idx, trace in enumerate(traces):
        trace_id = trace.get("trace_id") or f"trace_{t_idx}"
        spans = trace.get("spans") or []
        if verbose:
            print(f"  Trace {t_idx + 1}/{len(traces)}: {trace_id}  ({len(spans)} span(s))")

        for s_idx, span in enumerate(spans):
            result.span_count += 1
            span_id = span.get("span_id") or f"s{s_idx}"
            name = span.get("name") or span_id
            attrs = span.get("attributes") or {}
            recorded_in, recorded_out = _extract_io(attrs)

            if verbose:
                prefix = f"    [{s_idx + 1}/{len(spans)}]"
                in_s = _truncate(_json_repr(recorded_in)) if recorded_in is not None else "(none)"
                out_s = _truncate(_json_repr(recorded_out)) if recorded_out is not None else "(none)"
                print(f"{prefix} {name}")
                print(f"           in:  {in_s}")
                print(f"           out: {out_s}")

            if target_fn is None or recorded_in is None:
                continue

            # Call the target function with the recorded input.
            try:
                if isinstance(recorded_in, dict):
                    actual_out = target_fn(**recorded_in)
                else:
                    actual_out = target_fn(recorded_in)
            except Exception as exc:  # noqa: BLE001
                actual_out = f"<error: {exc}>"

            if actual_out != recorded_out:
                div: dict[str, Any] = {
                    "trace_id": trace_id,
                    "span_id": span_id,
                    "span_name": name,
                    "recorded_input": recorded_in,
                    "recorded_output": recorded_out,
                    "actual_output": actual_out,
                }
                result.divergences.append(div)
                if verbose:
                    print(
                        f"           DIVERGE  recorded={_truncate(_json_repr(recorded_out))}"
                    )
                    print(
                        f"                    actual  ={_truncate(_json_repr(actual_out))}"
                    )

    if verbose:
        print()
        if target_fn is not None:
            if result.ok:
                print(
                    f"OK — {result.span_count} span(s) replayed, 0 divergences."
                )
            else:
                print(
                    f"FAIL — {len(result.divergences)} divergence(s) in "
                    f"{result.span_count} span(s)."
                )
        else:
            print(f"Dry run — {result.span_count} span(s) printed.")

    return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> int:
    """Entry point for ``eden-debugger`` and ``python -m eden_sdk.replay``."""
    parser = argparse.ArgumentParser(
        prog="eden-debugger",
        description=(
            "Load an Eden failure fixture (eden-failure-fixture-v1 JSON) and "
            "replay it locally.\n\n"
            "Without --target: dry-run — prints each span's recorded input and "
            "output without invoking any external services.\n\n"
            "With --target module:function: calls that function with each span's "
            "recorded inputs and diffs the actual return value against the "
            "recorded output.  Exits non-zero on any divergence."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "fixture",
        metavar="FIXTURE",
        help="Path to the fixture JSON file exported from the Eden portal or MCP.",
    )
    parser.add_argument(
        "--target",
        metavar="MODULE:FUNCTION",
        default=None,
        help=(
            "Python callable to test, e.g. myapp.tools:inventory_lookup. "
            "Each span's recorded input is fed to the function as keyword "
            "arguments (when the input is a dict) or as a single positional "
            "argument; the actual output is diffed against the recorded output."
        ),
    )
    parser.add_argument(
        "--quiet",
        "-q",
        action="store_true",
        default=False,
        help="Suppress per-span output; print only the final summary on failure.",
    )

    args = parser.parse_args()

    try:
        fixture = load_fixture(args.fixture)
    except FixtureError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    target_fn: Callable[..., Any] | None = None
    if args.target:
        try:
            target_fn = _resolve_target(args.target)
        except FixtureError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1

    result = replay_fixture(fixture, target_fn=target_fn, verbose=not args.quiet)

    if not result.ok:
        if args.quiet:
            print(
                f"FAIL — {len(result.divergences)} divergence(s) in "
                f"{result.span_count} span(s).",
                file=sys.stderr,
            )
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
