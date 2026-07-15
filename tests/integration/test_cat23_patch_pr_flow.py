"""Cat 23 closed-loop E2E: patch → approve → sandbox test → PR.

Uses LocalPRProvider / LocalRepoProvider and mocks for DB + LLM.
Does not require live GitHub. Exercises the Gate 3 sandbox
substitute with ``code_change_enabled=true``.
"""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

GIT = "/usr/bin/git"


def _run_git(*args: str, cwd: Path) -> str:
    result = subprocess.run(
        [GIT, *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


@pytest.fixture
def temp_git_repo() -> Path:
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        _run_git("init", "-q", "--initial-branch=main", cwd=repo)
        _run_git("config", "user.email", "test@eden.local", cwd=repo)
        _run_git("config", "user.name", "Eden Test", cwd=repo)
        sample = repo / "sample.py"
        sample.write_text("def rate_limit():\n    return 42\n")
        test_file = repo / "test_sample.py"
        test_file.write_text(
            "from sample import rate_limit\n"
            "def test_rate_limit():\n"
            "    assert rate_limit() == 100\n"
        )
        _run_git("add", "sample.py", "test_sample.py", cwd=repo)
        _run_git("commit", "-q", "-m", "initial", cwd=repo)
        yield repo


@pytest.mark.asyncio
async def test_cat23_patch_pr_flow_local_sandbox(temp_git_repo: Path) -> None:
    from eden.code_change.inbox.review import PRReviewService
    from eden.code_change.patch_generator import PatchGenerator
    from eden.code_change.pr_creator import PRCreator
    from eden.code_change.test_runner import TestPlanRunner
    from eden.providers.pr import LocalPRProvider, PRCreateRequest
    from eden.providers.repo import FileEntry

    synthetic_diff = (
        "--- a/sample.py\n+++ b/sample.py\n"
        "@@ -1,2 +1,2 @@\n"
        " def rate_limit():\n"
        "-    return 42\n"
        "+    return 100  # patched\n"
    )
    patch_id = "patch-cat23-loop"
    policy = {
        "code_change_enabled": True,
        "auto_pr_enabled": True,
        "auto_revert_enabled": True,
    }

    class _FakeResp:
        content = f"```diff\n{synthetic_diff}\n```"
        model = "fake"
        usage = type("U", (), {"cost": 0.0})()

    class _FakeRouter:
        async def aroute(self, *args, **kwargs):
            return _FakeResp()

    # 1. Generate patch
    gen = PatchGenerator(router=_FakeRouter())
    with (
        patch(
            "eden.code_change.patch_generator._critic_review",
            AsyncMock(return_value={"passed": True, "issues": []}),
        ),
        patch(
            "eden.code_change.patch_generator._is_similar_to_recent_patch",
            AsyncMock(return_value=None),
        ),
        patch(
            "eden.code_change.patch_generator._insert_row",
            AsyncMock(return_value=None),
        ),
        patch(
            "eden.code_change.patch_generator._new_id",
            return_value=patch_id,
        ),
    ):
        gen_result = await gen.generate(
            "test-org",
            rca_id="rca-loop",
            trace_id="trace-loop",
            repo_id="repo-loop",
            linked_files=[{"path": "sample.py", "confidence": 0.9}],
            test_plan=["test_rate_limit"],
            rca_summary="rate_limit returns wrong value",
        )
    assert gen_result["status"] == "ok", gen_result

    # 2. Approve
    reviewer = PRReviewService()
    with (
        patch(
            "eden.code_change.inbox.review._insert_row",
            AsyncMock(return_value=None),
        ),
        patch(
            "eden.code_change.inbox.review._update_row",
            AsyncMock(return_value=None),
        ),
    ):
        approve_result = await reviewer.act(
            "test-org",
            patch_id,
            "approve",
            policy,
            actor_user_id="user-loop",
            comment="lgtm",
        )
    assert approve_result["status"] == "ok", approve_result

    # 3. Local sandbox test (Gate 3 substitute)
    import sys

    patched = "def rate_limit():\n    return 100  # patched\n"
    runner = TestPlanRunner(router=None)
    with patch(
        "eden.code_change.test_runner._insert_row",
        AsyncMock(return_value=None),
    ):
        run_result = await runner.run(
            "test-org",
            patch_id=patch_id,
            policy=policy,
            files=[
                {"path": "sample.py", "content": patched},
                {
                    "path": "test_sample.py",
                    "content": (
                        "from sample import rate_limit\n"
                        "def test_rate_limit():\n"
                        "    assert rate_limit() == 100\n"
                    ),
                },
            ],
            command=[sys.executable, "-m", "pytest", "-q"],
        )
    assert run_result["status"] == "ok", run_result
    assert run_result["data"]["exit_code"] == 0
    assert run_result["data"]["pass_rate"] >= 0.0

    # 4. Open PR via LocalPRProvider (no live GitHub)
    provider = LocalPRProvider(repo_path=str(temp_git_repo))
    creator = PRCreator(provider=provider)
    req = PRCreateRequest(
        title="[Eden Agent] Fix rate_limit",
        body="Cat 23 closed-loop E2E",
        branch="eden/cat23-loop",
        base="main",
        draft=True,
        files=[
            FileEntry(path="sample.py", size=0, content=patched),
        ],
    )
    with patch.object(
        creator, "resolve_codeowners_reviewers", AsyncMock(return_value=[]),
    ):
        pr_result = await creator.create(
            org_id="test-org",
            patch_id=patch_id,
            policy=policy,
            req=req,
        )
    assert pr_result["status"] == "ok", pr_result
    assert pr_result["data"]["pr"]["branch"] == "eden/cat23-loop"
    assert "return 100" in (temp_git_repo / "sample.py").read_text()
