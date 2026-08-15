"""M8 (spec §4.2) — targeted sandbox test gate.

Discovery is convention-glob only (capped), execution is honest
(import/collection errors are labeled skips, never failures), genuine
assertion failures earn exactly one regenerate then suppress, and test
synthesis is default-OFF with mandatory network isolation when on.
"""

from __future__ import annotations

import fnmatch
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest

from eden.improvement import issue_patch_trigger as ipt
from eden.improvement import test_gate as tg
from eden.sandbox.runner import SandboxResult

ORG = "org-test-gate"

_BASE_CONTENT = "def checkout(total):\n    return total / 0  # BUG\n"
_DIFF = (
    "--- a/agent/checkout.py\n"
    "+++ b/agent/checkout.py\n"
    "@@ -1,2 +1,2 @@\n"
    " def checkout(total):\n"
    "-    return total / 0  # BUG\n"
    "+    return total\n"
)
_LINKED = [{"path": "agent/checkout.py", "content": _BASE_CONTENT}]


class FakeProvider:
    """Minimal RepoProvider: glob over an in-memory path→content map."""

    def __init__(self, files: dict[str, str]) -> None:
        self.files = dict(files)
        self.globs: list[str] = []

    async def list_files(self, path_glob: str = "**/*") -> list[Any]:
        self.globs.append(path_glob)
        return [
            SimpleNamespace(path=p)
            for p in self.files
            if fnmatch.fnmatch(p, path_glob)
        ]

    async def read_file(self, path: str) -> str:
        return self.files.get(path, "")


def _sandbox(exit_code=0, stdout="", stderr="", timed_out=False, error=None):
    return SandboxResult(
        exit_code=exit_code,
        stdout=stdout,
        stderr=stderr,
        timed_out=timed_out,
        error=error,
    )


@pytest.fixture(autouse=True)
def _enabled(monkeypatch: pytest.MonkeyPatch):
    """Bypass the org-features DB read; settings default stays True."""
    monkeypatch.setattr(tg, "_org_enabled", AsyncMock(return_value=True))


# ── Discovery ───────────────────────────────────────────────────


async def test_discovery_python_convention_and_cap() -> None:
    provider = FakeProvider(
        {
            "tests/test_checkout_a.py": "",
            "tests/test_checkout_b.py": "",
            "tests/test_checkout_c.py": "",
            "tests/test_checkout_d.py": "",
            "tests/test_unrelated.py": "",
        }
    )
    found = await tg.discover_candidate_tests(["agent/checkout.py"], provider)
    assert len(found) == tg.MAX_CANDIDATE_TESTS == 3
    assert all("test_checkout" in p for p in found)
    assert found == sorted(found), "deterministic (sorted within a glob)"


async def test_discovery_ts_and_go_conventions() -> None:
    provider = FakeProvider(
        {
            "ui/button.test.ts": "",
            "pkg/server_test.go": "",
            "tests/test_other.py": "",
        }
    )
    assert await tg.discover_candidate_tests(["ui/button.ts"], provider) == [
        "ui/button.test.ts"
    ]
    assert await tg.discover_candidate_tests(["pkg/server.go"], provider) == [
        "pkg/server_test.go"
    ]


async def test_discovery_skips_test_file_sources() -> None:
    provider = FakeProvider({"tests/test_checkout.py": ""})
    found = await tg.discover_candidate_tests(
        ["tests/test_checkout.py"], provider
    )
    assert found == []


# ── Execution verdicts ──────────────────────────────────────────


async def test_gate_pass(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = FakeProvider({"tests/test_checkout.py": "def test_ok():\n    pass\n"})
    calls: list[dict[str, Any]] = []

    async def fake_run(command, **kwargs):
        calls.append({"command": command, **kwargs})
        return _sandbox(exit_code=0, stdout="1 passed")

    monkeypatch.setattr(tg, "run_in_sandbox", fake_run)
    result = await tg.run_test_gate(
        ORG, "repo-1", _DIFF, _LINKED, provider=provider, base_files=_LINKED
    )
    assert result.status == "passed"
    assert result.tests_run == ["tests/test_checkout.py"]
    assert result.synthesized is False
    # Discovered (non-synthesized) tests do not demand isolation.
    assert calls[0]["require_isolation"] is False
    # The patched content (not the buggy base) was materialized.
    files = {f["path"]: f["content"] for f in calls[0]["files"]}
    assert "/ 0" not in files["agent/checkout.py"]
    assert "tests/test_checkout.py" in files


async def test_gate_genuine_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = FakeProvider({"tests/test_checkout.py": "def test_x():\n    assert 0\n"})
    monkeypatch.setattr(
        tg,
        "run_in_sandbox",
        AsyncMock(
            return_value=_sandbox(
                exit_code=1, stdout="AssertionError: boom\n2 failed, 1 passed"
            )
        ),
    )
    result = await tg.run_test_gate(
        ORG, "repo-1", _DIFF, _LINKED, provider=provider, base_files=_LINKED
    )
    assert result.status == "failed"
    assert result.failures == 2
    assert "AssertionError" in result.output_excerpt


async def test_gate_timeout_is_labeled_skip(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = FakeProvider({"tests/test_checkout.py": "x"})
    monkeypatch.setattr(
        tg,
        "run_in_sandbox",
        AsyncMock(return_value=_sandbox(exit_code=124, timed_out=True)),
    )
    result = await tg.run_test_gate(
        ORG, "repo-1", _DIFF, _LINKED, provider=provider, base_files=_LINKED
    )
    assert result.status == "skipped"
    assert result.reason == "timeout"


@pytest.mark.parametrize(
    ("exit_code", "output"),
    [
        (2, "ERROR collecting tests/test_checkout.py"),
        (1, "ModuleNotFoundError: No module named 'requests'"),
        (1, "ImportError: cannot import name 'x'"),
        (2, "npm ERR! missing script: test"),
    ],
)
async def test_import_collection_errors_never_fail(
    monkeypatch: pytest.MonkeyPatch, exit_code: int, output: str
) -> None:
    provider = FakeProvider({"tests/test_checkout.py": "x"})
    monkeypatch.setattr(
        tg,
        "run_in_sandbox",
        AsyncMock(return_value=_sandbox(exit_code=exit_code, stdout=output)),
    )
    result = await tg.run_test_gate(
        ORG, "repo-1", _DIFF, _LINKED, provider=provider, base_files=_LINKED
    )
    assert result.status == "skipped", "env problems must NEVER read as failed"
    assert result.reason == "env_unavailable"


async def test_no_tests_found_is_labeled_skip() -> None:
    provider = FakeProvider({"src/other.py": ""})
    result = await tg.run_test_gate(
        ORG, "repo-1", _DIFF, _LINKED, provider=provider, base_files=_LINKED
    )
    assert result.status == "skipped"
    assert result.reason == "no_tests_found"


async def test_disabled_gate_skips(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tg, "_org_enabled", AsyncMock(return_value=False))
    result = await tg.run_test_gate(
        ORG, "repo-1", _DIFF, _LINKED, provider=FakeProvider({}), base_files=_LINKED
    )
    assert result.status == "skipped"
    assert result.reason == "disabled"


async def test_patch_touching_its_own_tests_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """§7.3 — the self-validating patch trick is refused, not run."""
    diff = (
        "--- a/tests/test_checkout.py\n"
        "+++ b/tests/test_checkout.py\n"
        "@@ -1,1 +1,1 @@\n"
        "-def test_x():\n"
        "+def test_y():\n"
    )
    provider = FakeProvider({"tests/test_checkout.py": "x"})
    monkeypatch.setattr(
        tg,
        "discover_candidate_tests",
        AsyncMock(return_value=["tests/test_checkout.py"]),
    )
    result = await tg.run_test_gate(
        ORG, "repo-1", diff, [], provider=provider, base_files=[]
    )
    assert result.status == "skipped"
    assert result.reason == "patch_touches_tests"


# ── Feedback regenerate → suppress ──────────────────────────────


async def test_regenerate_marks_origin_and_suppresses_on_second_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    generate = AsyncMock(
        return_value={"data": {"status": "proposed", "diff": _DIFF, "cost_usd": 0.01}}
    )
    monkeypatch.setattr(
        "eden.patches.patch_generator.PatchGenerator.generate", generate
    )
    retry = AsyncMock(
        return_value={"status": "failed", "reason": "tests_failed", "tests_run": []}
    )
    monkeypatch.setattr(ipt, "_run_sandbox_test_gate", retry)

    data, summary, ok = await ipt._regenerate_after_test_failure(
        ORG,
        rca_id="iss-1",
        trace_id="trc-1",
        repo_id="repo-1",
        rca_summary="rca",
        linked_files=_LINKED,
        agent_id=None,
        data={"status": "proposed", "diff": "old", "cost_usd": 0.02},
        test_gate_summary={
            "status": "failed",
            "tests_run": ["tests/test_checkout.py"],
            "output_excerpt": "AssertionError: boom",
        },
    )
    assert ok is False, "second failure must suppress"
    assert summary["regenerated"] is True
    feedback = generate.await_args.kwargs["static_feedback"]
    assert "[origin: test_gate]" in feedback
    assert "AssertionError: boom" in feedback


async def test_regenerate_accepts_candidate_that_passes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "eden.patches.patch_generator.PatchGenerator.generate",
        AsyncMock(
            return_value={
                "data": {"status": "proposed", "diff": _DIFF, "cost_usd": 0.01}
            }
        ),
    )
    monkeypatch.setattr(
        ipt,
        "_run_sandbox_test_gate",
        AsyncMock(return_value={"status": "passed", "reason": "tests_passed"}),
    )
    data, summary, ok = await ipt._regenerate_after_test_failure(
        ORG,
        rca_id="iss-1",
        trace_id="trc-1",
        repo_id="repo-1",
        rca_summary="rca",
        linked_files=_LINKED,
        agent_id=None,
        data={"status": "proposed", "diff": "old", "cost_usd": 0.02},
        test_gate_summary={"status": "failed", "tests_run": [], "output_excerpt": ""},
    )
    assert ok is True
    assert data["diff"] == _DIFF
    assert data["cost_usd"] == pytest.approx(0.03), "both attempts' cost carried"
    assert summary["status"] == "passed"


# ── Synthesis (default OFF, §4.2) ───────────────────────────────


def test_synthesis_flag_default_off() -> None:
    from eden.config import get_settings

    assert get_settings().test_gate_synthesis_v1 is False


async def test_synthesis_off_makes_no_llm_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    synthesize = AsyncMock()
    monkeypatch.setattr(tg, "_synthesize_test", synthesize)
    monkeypatch.setattr(tg, "_synthesis_enabled", AsyncMock(return_value=False))
    result = await tg.run_test_gate(
        ORG, "repo-1", _DIFF, _LINKED, provider=FakeProvider({}), base_files=_LINKED
    )
    assert result.status == "skipped"
    assert result.reason == "no_tests_found"
    synthesize.assert_not_awaited()


async def test_synthesis_on_writes_marked_test_with_mandatory_isolation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(tg, "_synthesis_enabled", AsyncMock(return_value=True))
    monkeypatch.setattr(
        tg,
        "_synthesize_test",
        AsyncMock(
            return_value=(
                "tests/eden_regression/test_regression_checkout.py",
                "def test_regression():\n    assert True\n",
                0.01,
            )
        ),
    )
    calls: list[dict[str, Any]] = []

    async def fake_run(command, **kwargs):
        calls.append({"command": command, **kwargs})
        return _sandbox(exit_code=0, stdout="1 passed")

    monkeypatch.setattr(tg, "run_in_sandbox", fake_run)
    result = await tg.run_test_gate(
        ORG, "repo-1", _DIFF, _LINKED, provider=FakeProvider({}), base_files=_LINKED
    )
    assert result.status == "passed"
    assert result.synthesized is True
    assert result.tests_run == ["tests/eden_regression/test_regression_checkout.py"]
    assert result.cost_usd == pytest.approx(0.01)
    assert calls[0]["require_isolation"] is True, "§7.3 — isolation is mandatory"
    paths = [f["path"] for f in calls[0]["files"]]
    assert "tests/eden_regression/test_regression_checkout.py" in paths


async def test_synthesized_test_skipped_when_isolation_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """§7.3 — never run LLM-authored tests unisolated."""
    monkeypatch.setattr(tg, "_synthesis_enabled", AsyncMock(return_value=True))
    monkeypatch.setattr(
        tg,
        "_synthesize_test",
        AsyncMock(
            return_value=(
                "tests/eden_regression/test_regression_checkout.py",
                "def test_regression():\n    assert True\n",
                0.0,
            )
        ),
    )
    monkeypatch.setattr(
        tg,
        "run_in_sandbox",
        AsyncMock(
            return_value=_sandbox(exit_code=125, error="isolation_unavailable")
        ),
    )
    result = await tg.run_test_gate(
        ORG, "repo-1", _DIFF, _LINKED, provider=FakeProvider({}), base_files=_LINKED
    )
    assert result.status == "skipped"
    assert result.reason == "no_isolation"
    assert result.synthesized is True
