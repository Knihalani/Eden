"""Tests for ``eden_sdk.replay`` (OOM plan §9.2 / W2-9).

Covers:
  - fixture load (valid, missing file, bad JSON, wrong format)
  - dry-run output and result
  - divergence detection with a toy target
  - CLI entry-point (main()) exit codes
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest

from eden_sdk.replay import (
    FixtureError,
    ReplayResult,
    _extract_io,
    load_fixture,
    replay_fixture,
)

# ---------------------------------------------------------------------------
# Minimal valid fixture
# ---------------------------------------------------------------------------

_FIXTURE_V1: dict[str, Any] = {
    "format": "eden-failure-fixture-v1",
    "exported_at": "2026-08-01T00:00:00Z",
    "issue": {"id": "iss_001", "title": "inventory lookup returns wrong count"},
    "traces": [
        {
            "trace_id": "abc123def456abc1",
            "spans": [
                {
                    "span_id": "s001",
                    "name": "inventory_lookup",
                    "attributes": {
                        "input": {"item_id": "widget", "warehouse": "us-east"},
                        "output": {"count": 42},
                    },
                },
                {
                    "span_id": "s002",
                    "name": "llm_call",
                    "attributes": {
                        "gen_ai.input": "summarise stock",
                        "gen_ai.output": "Stock is 42 units.",
                    },
                },
                {
                    "span_id": "s003",
                    "name": "no_io_span",
                    "attributes": {},
                },
            ],
        }
    ],
}


def _write_fixture(tmp_path: Path, data: dict[str, Any]) -> Path:
    p = tmp_path / "fixture.json"
    p.write_text(json.dumps(data), encoding="utf-8")
    return p


# ---------------------------------------------------------------------------
# load_fixture tests
# ---------------------------------------------------------------------------


def test_load_fixture_missing_file(tmp_path: Path) -> None:
    """A non-existent path must raise FixtureError, not OSError."""
    with pytest.raises(FixtureError, match="Cannot read fixture file"):
        load_fixture(tmp_path / "does_not_exist.json")


def test_load_fixture_invalid_json(tmp_path: Path) -> None:
    """A file with corrupt JSON must raise FixtureError."""
    bad = tmp_path / "bad.json"
    bad.write_text("{not json}", encoding="utf-8")
    with pytest.raises(FixtureError, match="Invalid JSON"):
        load_fixture(bad)


def test_load_fixture_wrong_format(tmp_path: Path) -> None:
    """A fixture with an unexpected ``format`` field must raise FixtureError."""
    data = dict(_FIXTURE_V1, format="unknown-v99")
    p = _write_fixture(tmp_path, data)
    with pytest.raises(FixtureError, match="Expected format="):
        load_fixture(p)


def test_load_fixture_root_not_dict(tmp_path: Path) -> None:
    """A root that is a list (not a dict) must raise FixtureError."""
    p = tmp_path / "list.json"
    p.write_text("[1, 2, 3]", encoding="utf-8")
    with pytest.raises(FixtureError, match="must be a JSON object"):
        load_fixture(p)


def test_load_fixture_valid(tmp_path: Path) -> None:
    """A well-formed fixture is loaded and returned unchanged."""
    p = _write_fixture(tmp_path, _FIXTURE_V1)
    result = load_fixture(p)
    assert result["format"] == "eden-failure-fixture-v1"
    assert result["issue"]["id"] == "iss_001"
    assert len(result["traces"]) == 1
    assert len(result["traces"][0]["spans"]) == 3


def test_load_fixture_accepts_path_object(tmp_path: Path) -> None:
    """``load_fixture`` accepts a ``pathlib.Path`` as well as a string."""
    p = _write_fixture(tmp_path, _FIXTURE_V1)
    result_from_path = load_fixture(p)
    result_from_str = load_fixture(str(p))
    assert result_from_path == result_from_str


# ---------------------------------------------------------------------------
# _extract_io helper
# ---------------------------------------------------------------------------


def test_extract_io_direct_keys() -> None:
    attrs = {"input": {"x": 1}, "output": {"y": 2}}
    inp, out = _extract_io(attrs)
    assert inp == {"x": 1}
    assert out == {"y": 2}


def test_extract_io_gen_ai_keys() -> None:
    attrs = {"gen_ai.input": "prompt", "gen_ai.output": "completion"}
    inp, out = _extract_io(attrs)
    assert inp == "prompt"
    assert out == "completion"


def test_extract_io_empty() -> None:
    inp, out = _extract_io({})
    assert inp is None
    assert out is None


# ---------------------------------------------------------------------------
# dry-run tests
# ---------------------------------------------------------------------------


def test_dry_run_prints_steps(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """Dry-run (no target) must print each span name and return ok."""
    result = replay_fixture(_FIXTURE_V1, target_fn=None, verbose=True)

    out = capsys.readouterr().out
    # Header block
    assert "eden-failure-fixture-v1" in out
    assert "iss_001" in out
    # Span names printed
    assert "inventory_lookup" in out
    assert "llm_call" in out
    assert "no_io_span" in out
    # Summary line
    assert "Dry run" in out
    assert "3 span(s)" in out
    assert result.ok
    assert result.span_count == 3
    assert result.divergences == []


def test_dry_run_quiet_suppresses_output(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """``verbose=False`` must produce no stdout."""
    replay_fixture(_FIXTURE_V1, target_fn=None, verbose=False)
    out = capsys.readouterr().out
    assert out == ""


def test_dry_run_result_is_ok() -> None:
    result = replay_fixture(_FIXTURE_V1, target_fn=None, verbose=False)
    assert isinstance(result, ReplayResult)
    assert result.ok is True
    assert result.span_count == 3


# ---------------------------------------------------------------------------
# Target mode — matching output (no divergence)
# ---------------------------------------------------------------------------


def _exact_target(item_id: str, warehouse: str) -> dict[str, Any]:
    """Toy function that exactly replicates the recorded output for s001."""
    return {"count": 42}


def test_target_matching_recorded_no_divergence() -> None:
    """The ``inventory_lookup`` span (s001) must NOT diverge when the target
    exactly replicates its recorded output.  Spans with non-dict inputs (s002)
    or no inputs (s003) may diverge independently — we only check s001."""
    result = replay_fixture(
        _FIXTURE_V1, target_fn=_exact_target, verbose=False
    )
    # s001 uses dict input → _exact_target(**{item_id, warehouse}) → {"count":42}
    # which matches the recorded output.  No divergence for that span.
    assert all(d["span_name"] != "inventory_lookup" for d in result.divergences)


def test_target_matching_dict_input_only(tmp_path: Path) -> None:
    """Target receives dict inputs from s001 and returns the recorded value."""
    # Use a single-span fixture so we control the exact call.
    single_span_fixture: dict[str, Any] = {
        "format": "eden-failure-fixture-v1",
        "exported_at": "2026-08-01T00:00:00Z",
        "issue": {"id": "iss_002", "title": "single span"},
        "traces": [
            {
                "trace_id": "t0001",
                "spans": [
                    {
                        "span_id": "s1",
                        "name": "lookup",
                        "attributes": {
                            "input": {"item_id": "a", "warehouse": "b"},
                            "output": {"count": 7},
                        },
                    }
                ],
            }
        ],
    }

    def matching_fn(item_id: str, warehouse: str) -> dict[str, Any]:
        return {"count": 7}

    result = replay_fixture(single_span_fixture, target_fn=matching_fn, verbose=False)
    assert result.ok
    assert result.divergences == []
    assert result.span_count == 1


# ---------------------------------------------------------------------------
# Target mode — divergence detection
# ---------------------------------------------------------------------------


def test_divergence_detected_with_wrong_return(tmp_path: Path) -> None:
    """A toy target that returns the wrong value must produce a divergence."""
    single_span_fixture: dict[str, Any] = {
        "format": "eden-failure-fixture-v1",
        "exported_at": "2026-08-01T00:00:00Z",
        "issue": {"id": "iss_003", "title": "diverge test"},
        "traces": [
            {
                "trace_id": "t0002",
                "spans": [
                    {
                        "span_id": "s1",
                        "name": "compute",
                        "attributes": {
                            "input": {"x": 5},
                            "output": 25,  # recorded: x**2
                        },
                    }
                ],
            }
        ],
    }

    def buggy_fn(x: int) -> int:
        # Returns x*2 instead of x**2 → diverges
        return x * 2

    result = replay_fixture(single_span_fixture, target_fn=buggy_fn, verbose=False)
    assert not result.ok
    assert len(result.divergences) == 1
    div = result.divergences[0]
    assert div["span_name"] == "compute"
    assert div["recorded_output"] == 25
    assert div["actual_output"] == 10
    assert div["span_id"] == "s1"


def test_divergence_verbose_output(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Verbose mode must print ``DIVERGE`` when outputs differ."""
    fixture: dict[str, Any] = {
        "format": "eden-failure-fixture-v1",
        "exported_at": "2026-08-01T00:00:00Z",
        "issue": {"id": "iss_004", "title": "verbose diverge"},
        "traces": [
            {
                "trace_id": "t0003",
                "spans": [
                    {
                        "span_id": "s1",
                        "name": "fn",
                        "attributes": {"input": {"v": 1}, "output": "expected"},
                    }
                ],
            }
        ],
    }

    def wrong_fn(v: int) -> str:
        return "actual"

    replay_fixture(fixture, target_fn=wrong_fn, verbose=True)
    out = capsys.readouterr().out
    assert "DIVERGE" in out
    assert "expected" in out
    assert "actual" in out


def test_multiple_divergences_counted(tmp_path: Path) -> None:
    """Each diverging span contributes one entry to ``result.divergences``."""
    multi_fixture: dict[str, Any] = {
        "format": "eden-failure-fixture-v1",
        "exported_at": "2026-08-01T00:00:00Z",
        "issue": {"id": "iss_005", "title": "multi"},
        "traces": [
            {
                "trace_id": "t0004",
                "spans": [
                    {
                        "span_id": f"s{i}",
                        "name": f"fn_{i}",
                        "attributes": {"input": {"n": i}, "output": i * i},
                    }
                    for i in range(1, 4)
                ],
            }
        ],
    }

    def wrong_fn(n: int) -> int:
        return 0  # always wrong

    result = replay_fixture(multi_fixture, target_fn=wrong_fn, verbose=False)
    assert not result.ok
    assert result.span_count == 3
    assert len(result.divergences) == 3


def test_span_with_no_recorded_input_skipped(tmp_path: Path) -> None:
    """Spans without a recorded input must be skipped (no target call)."""
    fixture: dict[str, Any] = {
        "format": "eden-failure-fixture-v1",
        "exported_at": "2026-08-01T00:00:00Z",
        "issue": {"id": "iss_006", "title": "no-input"},
        "traces": [
            {
                "trace_id": "t0005",
                "spans": [
                    {
                        "span_id": "s1",
                        "name": "no_input_span",
                        "attributes": {"output": "something"},
                    }
                ],
            }
        ],
    }

    calls: list[Any] = []

    def tracking_fn(*args: Any, **kwargs: Any) -> None:
        calls.append((args, kwargs))

    result = replay_fixture(fixture, target_fn=tracking_fn, verbose=False)
    # Target must not have been called.
    assert calls == []
    # No divergences because the span was skipped.
    assert result.ok


# ---------------------------------------------------------------------------
# Error in target function
# ---------------------------------------------------------------------------


def test_target_raising_exception_recorded_as_divergence(tmp_path: Path) -> None:
    """If the target function raises, the error string is the actual output."""
    fixture: dict[str, Any] = {
        "format": "eden-failure-fixture-v1",
        "exported_at": "2026-08-01T00:00:00Z",
        "issue": {"id": "iss_007", "title": "error"},
        "traces": [
            {
                "trace_id": "t0006",
                "spans": [
                    {
                        "span_id": "s1",
                        "name": "fn",
                        "attributes": {"input": {"x": 1}, "output": 42},
                    }
                ],
            }
        ],
    }

    def exploding_fn(**_: Any) -> None:
        raise ValueError("boom")

    result = replay_fixture(fixture, target_fn=exploding_fn, verbose=False)
    assert not result.ok
    div = result.divergences[0]
    assert "error" in div["actual_output"].lower() or "boom" in div["actual_output"]


# ---------------------------------------------------------------------------
# CLI entry-point (main)
# ---------------------------------------------------------------------------


def test_main_dry_run_exit_zero(tmp_path: Path) -> None:
    """``main()`` returns 0 for a successful dry-run."""
    from eden_sdk.replay import main as replay_main

    p = _write_fixture(tmp_path, _FIXTURE_V1)
    sys.argv = ["eden-debugger", str(p)]
    code = replay_main()
    assert code == 0


def test_main_missing_file_exit_one(tmp_path: Path) -> None:
    """``main()`` returns 1 when the fixture file does not exist."""
    from eden_sdk.replay import main as replay_main

    sys.argv = ["eden-debugger", str(tmp_path / "missing.json")]
    code = replay_main()
    assert code == 1


def test_main_divergence_exit_one(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """``main()`` returns 1 when ``--target`` reports a divergence.

    Writes a toy module to a temp dir, adds it to ``sys.path``, then runs
    the CLI with ``--target`` pointing at a function that returns the wrong
    value so at least one divergence is detected.
    """
    # Write a toy target module.
    toy = tmp_path / "toy_target.py"
    toy.write_text("def compute(x): return 0\n")  # always returns 0 (wrong)

    # Write a single-span fixture whose recorded output is x*x (never 0 for x>0).
    fixture: dict[str, Any] = {
        "format": "eden-failure-fixture-v1",
        "exported_at": "2026-08-01T00:00:00Z",
        "issue": {"id": "iss_cli", "title": "cli diverge"},
        "traces": [
            {
                "trace_id": "tcli",
                "spans": [
                    {
                        "span_id": "s1",
                        "name": "compute",
                        "attributes": {"input": {"x": 5}, "output": 25},
                    }
                ],
            }
        ],
    }
    p = _write_fixture(tmp_path, fixture)

    monkeypatch.syspath_prepend(str(tmp_path))
    from eden_sdk.replay import main as replay_main

    sys.argv = ["eden-debugger", "--quiet", "--target", "toy_target:compute", str(p)]
    code = replay_main()
    assert code == 1


def test_main_quiet_flag(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """``--quiet`` suppresses per-span output on a successful dry-run."""
    from eden_sdk.replay import main as replay_main

    p = _write_fixture(tmp_path, _FIXTURE_V1)
    sys.argv = ["eden-debugger", "--quiet", str(p)]
    code = replay_main()
    out = capsys.readouterr().out
    assert code == 0
    # Quiet dry-run (ok) produces no stdout.
    assert out == ""


def test_module_main_invocable(tmp_path: Path) -> None:
    """``python -m eden_sdk.replay`` resolves to the same ``main`` callable."""
    import importlib

    mod = importlib.import_module("eden_sdk.replay")
    assert callable(mod.main)
    # __main__ guard exists so ``python -m eden_sdk.replay`` works.
    src = Path(mod.__file__).read_text()
    assert 'if __name__ == "__main__"' in src
