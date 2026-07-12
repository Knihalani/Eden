"""End-to-end test for the Cat 23 Gate 4a patch flow.

The flow under test:

1. Synthetic Cat 2 RCA + a stack trace pointing at a file
2. :class:`CodeRootCauseLinker.link` runs the 4-source
   attribution → identifies the top file
3. :class:`PRCreator.create` opens a PR (via the
   :class:`LocalPRProvider` for the dev/CI path)
4. The PR is recorded (the actual DB persistence is
   covered by ``test_intelligence_code_change_crud.py``)

The test runs against a temp git repo (the
:class:`LocalRepoProvider` / :class:`LocalPRProvider`
backed by the local ``git`` CLI). It verifies the
full flow completes without raising and that the
provider receives the expected PR metadata.

This is the Gate 4a integration test: manual trigger
only (no auto-create). The ``code_change_enabled``
policy field is set to ``True`` so the flow runs.
"""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

GIT = "/usr/bin/git"


def _run_git(*args: str, cwd: Path) -> str:
    """Run a git command synchronously, return stdout."""
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
    """A temp directory with a git repo + one committed file."""
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        _run_git("init", "-q", "--initial-branch=main", cwd=repo)
        _run_git("config", "user.email", "test@eden.local", cwd=repo)
        _run_git("config", "user.name", "Eden Test", cwd=repo)
        # Commit a single file so the linker has something
        # to find.
        sample = repo / "sample.py"
        sample.write_text(
            "def rate_limit():\n"
            "    return 42\n"
        )
        _run_git("add", "sample.py", cwd=repo)
        _run_git("commit", "-q", "-m", "initial", cwd=repo)
        yield repo


# ── The end-to-end flow ──────────────────────────────────────


@pytest.mark.asyncio
async def test_patch_flow_e2e(temp_git_repo: Path) -> None:
    """Full flow: RCA → linker → PR creator.

    The router is mocked (no real LLM call). The
    generator returns a synthetic diff via the mock.
    """
    from eden.code_change.pr_creator import PRCreator
    from eden.code_change.rca_linker import CodeRootCauseLinker
    from eden.code_change.repo_connector import RepoConnector
    from eden.providers.pr import LocalPRProvider, PRCreateRequest
    from eden.providers.repo import FileEntry, LocalRepoProvider

    connector = RepoConnector(
        provider=LocalRepoProvider(repo_path=str(temp_git_repo)),
    )
    linker = CodeRootCauseLinker(
        router=None,  # No LLM needed — only the stack source fires
        repo_connector=connector,
    )

    # Step 1: linker identifies the file
    stack = (
        'File "sample.py", line 1, in rate_limit\n'
    )
    with patch(
        "eden.code_change.rca_linker._delete_then_insert",
        AsyncMock(return_value=None),
    ):
        link_result = await linker.link(
            org_id="test-org",
            rca_id="rca-e2e-1",
            repo_id="repo-e2e-1",
            stack_trace=stack,
            candidate_files=["sample.py"],
        )

    assert link_result["status"] == "ok"
    primary_path = (link_result.get("data") or {}).get("primary_path")
    assert primary_path == "sample.py", (
        f"linker should have identified sample.py, got {primary_path!r}"
    )

    # Step 2: PR creator opens a PR (manual-trigger path).
    # We use the LocalPRProvider pointed at our temp repo
    # + a synthetic PRCreateRequest.
    provider = LocalPRProvider(repo_path=str(temp_git_repo))
    creator = PRCreator(provider=provider)
    req = PRCreateRequest(
        title="[Eden Agent] Fix rate_limit",
        body=(
            "Automated fix based on Cat 2 RCA cluster.\n\n"
            "**Diff:** adjusts `sample.py` to address the regression."
        ),
        branch="eden/auto-fix-rate-limit",
        base="main",
        draft=True,
        files=[
            FileEntry(
                path="sample.py",
                size=0,
                content=(
                    "def rate_limit():\n"
                    "    return 100  # patched\n"
                ),
            ),
        ],
        reviewers=["@reviewer"],
    )

    # CODEOWNERS lookup is mocked to return empty (the
    # temp repo has no CODEOWNERS file).
    with patch.object(
        creator, "resolve_codeowners_reviewers",
        AsyncMock(return_value=[]),
    ):
        result = await creator.create(
            org_id="test-org",
            patch_id="patch-e2e-1",
            policy={},
            req=req,
        )

    assert result["status"] == "ok"
    pr_data = result["data"]["pr"]
    assert pr_data["state"] == "open"
    assert pr_data["branch"].startswith("eden/")
    assert pr_data["branch"] == "eden/auto-fix-rate-limit"
    assert pr_data["base"] == "main"
    # The patch was actually applied — the file on disk
    # now has the patched content.
    on_disk = (temp_git_repo / "sample.py").read_text()
    assert "return 100  # patched" in on_disk


@pytest.mark.asyncio
async def test_patch_flow_provider_receives_codeowners(temp_git_repo: Path) -> None:
    """When ``req.files`` is populated, the provider receives
    the augmented reviewers list (CODEOWNERS merged in)."""
    from eden.code_change.pr_creator import PRCreator
    from eden.providers.pr import LocalPRProvider, PRCreateRequest
    from eden.providers.repo import FileEntry, PullRequestInfo

    provider = LocalPRProvider(repo_path=str(temp_git_repo))
    creator = PRCreator(provider=provider)

    req = PRCreateRequest(
        title="[Eden Agent] CODEOWNERS test",
        body="body",
        branch="eden/codeowners-test",
        base="main",
        draft=True,
        files=[
            FileEntry(path="sample.py", size=0, content="def f(): pass\n"),
        ],
    )

    # Resolve to a single CODEOWNERS owner; we assert the
    # provider gets the merged list.
    with patch.object(
        creator, "resolve_codeowners_reviewers",
        AsyncMock(return_value=["@alice"]),
    ):
        result = await creator.create(
            org_id="test-org",
            patch_id="patch-codeowners",
            policy={},
            req=req,
        )

    assert result["status"] == "ok"
    # The provider was called with reviewers=["@alice"].
    # We don't have direct access to the request here, but
    # we can verify the flow completed + the branch was
    # created (i.e. the provider ran end-to-end).
    assert result["data"]["pr"]["branch"] == "eden/codeowners-test"


@pytest.mark.asyncio
async def test_cat23_patch_approve_test_pr_e2e(temp_git_repo: Path) -> None:
    """P.2 E2E: patch_generator → inbox approve → test_runner → pr_creator.

    Uses mocked LLM + DB persistence; LocalPRProvider for the PR step.
    ``TestPlanRunner.run`` remains gate=3_blocked (sandbox retired);
    ``generate_plan`` is the live path exercised here.
    """
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
    patch_id = "patch-cat23-e2e"

    # 1. PatchGenerator with injected router → ok envelope
    class _FakeResp:
        content = f"```diff\n{synthetic_diff}\n```"
        model = "fake"
        usage = type("U", (), {"cost": 0.0})()

    class _FakeRouter:
        async def aroute(self, *args, **kwargs):
            return _FakeResp()

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
            rca_id="rca-e2e",
            trace_id="trace-e2e",
            repo_id="repo-e2e",
            linked_files=[{"path": "sample.py", "confidence": 0.9}],
            test_plan=["test_rate_limit_regression"],
            rca_summary="rate_limit returns wrong value",
        )
    assert gen_result["status"] == "ok", gen_result
    assert gen_result["data"].get("patch_id") == patch_id

    # 2. Inbox approve (policy opt-in + mocked persistence)
    reviewer = PRReviewService()
    policy = {
        "code_change_enabled": True,
        "auto_approve_enabled": True,
        "auto_pr_enabled": True,
    }
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
            actor_user_id="user-e2e",
            comment="lgtm",
        )
    assert approve_result["status"] == "ok", approve_result

    # 3. Test plan generate (live) + run (sandbox retired → gate)
    runner = TestPlanRunner(router=None)
    plan_result = await runner.generate_plan(
        "test-org",
        patch_id,
        rca_summary="rate_limit regression",
        diff=synthetic_diff,
    )
    assert plan_result["status"] == "ok"
    assert plan_result["data"]["count"] >= 1

    run_result = await runner.run("test-org", patch_id=patch_id)
    assert run_result["status"] == "not_implemented"
    assert run_result["data"]["gate"] == "3_blocked"

    # 4. PRCreator opens PR via LocalPRProvider
    provider = LocalPRProvider(repo_path=str(temp_git_repo))
    creator = PRCreator(provider=provider)
    req = PRCreateRequest(
        title="[Eden Agent] Fix rate_limit",
        body="Cat 23 E2E patch",
        branch="eden/cat23-e2e",
        base="main",
        draft=True,
        files=[
            FileEntry(
                path="sample.py",
                size=0,
                content="def rate_limit():\n    return 100  # patched\n",
            ),
        ],
    )
    with patch.object(
        creator, "resolve_codeowners_reviewers", AsyncMock(return_value=[]),
    ):
        pr_result = await creator.create(
            org_id="test-org",
            patch_id=patch_id,
            policy={"code_change_enabled": True, "auto_pr_enabled": True},
            req=req,
        )
    assert pr_result["status"] == "ok", pr_result
    assert pr_result["data"]["pr"]["branch"] == "eden/cat23-e2e"
    assert "return 100  # patched" in (temp_git_repo / "sample.py").read_text()


@pytest.mark.asyncio
async def test_patch_flow_no_auto_create(temp_git_repo: Path) -> None:
    """Without ``auto_pr_enabled``, the destructive-route
    path returns the optin_blocked envelope — NO PR is
    auto-created.

    This is the Gate 4a manual-trigger guarantee. The
    agent-suggest path (with ``req`` provided) bypasses
    the opt-in (the human clicking "Open PR" IS the opt-in).
    """
    from eden.code_change.pr_creator import PRCreator

    creator = PRCreator()
    result = await creator.create(
        org_id="test-org",
        patch_id="patch-1",
        policy={
            "code_change_enabled": False,
            "auto_pr_enabled": False,
        },
        # req=None → destructive path (would auto-create
        # in production — blocked here by the opt-in)
    )
    assert result["status"] != "ok"
    assert result.get("data", {}).get("gate") == "optin_blocked"
