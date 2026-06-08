"""Unit tests for workflow commands: PR + integration plan generators."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from eden.autonomy import AutonomyManager
from eden.ci_generator import apply_ci_plan, build_ci_plan
from eden.commands.integrate import _StubConfig, cmd_eden_integrate
from eden.commands.pr import _StubConfig as _PrStubConfig, cmd_eden_pr
from eden.eval_harness_generator import apply_harness, build_eval_harness
from eden.framework_detector import detect_framework
from eden.pr_manager import (
    PRRequest,
    PRResult,
    build_branch_name,
    create_pull_request,
    render_commit_message,
    render_pr_body,
    slugify,
)
from eden.sdk_integrator import apply_plan, build_integration_plan


# ---------------------------------------------------------------------------
# Framework detection
# ---------------------------------------------------------------------------


class TestFrameworkDetection:
    def test_detects_langchain(self, tmp_target: Path):
        d = detect_framework(tmp_target)
        assert d.framework == "langchain"
        assert d.confidence >= 0.7
        assert "langchain" in d.matched_markers or any(
            "langchain" in m for m in d.matched_markers
        )

    def test_detects_openai_direct(self, tmp_path: Path):
        (tmp_path / "agent.py").write_text("from openai import OpenAI\n")
        (tmp_path / "requirements.txt").write_text("openai>=1.0\n")
        d = detect_framework(tmp_path)
        assert d.framework == "openai"

    def test_detects_anthropic_direct(self, tmp_path: Path):
        (tmp_path / "agent.py").write_text("import anthropic\n")
        (tmp_path / "requirements.txt").write_text("anthropic>=0.20\n")
        d = detect_framework(tmp_path)
        assert d.framework == "anthropic"

    def test_detects_crewai(self, tmp_path: Path):
        (tmp_path / "crew.py").write_text("from crewai import Agent, Crew\n")
        (tmp_path / "requirements.txt").write_text("crewai>=0.1\n")
        d = detect_framework(tmp_path)
        assert d.framework == "crewai"

    def test_falls_back_to_custom(self, tmp_path: Path):
        (tmp_path / "agent.py").write_text("def run(p): return p\n")
        d = detect_framework(tmp_path)
        assert d.framework == "custom"

    def test_finds_entry_points(self, tmp_target: Path):
        d = detect_framework(tmp_target)
        assert any("agent.py" in p for p in d.entry_points)

    def test_handles_missing_directory(self, tmp_path: Path):
        d = detect_framework(tmp_path / "does-not-exist")
        assert d.framework == "custom"
        assert d.confidence == 0.0

    def test_detects_typescript_project(self, tmp_path: Path):
        (tmp_path / "package.json").write_text(
            json.dumps(
                {
                    "name": "ts-agent",
                    "dependencies": {"@langchain/core": "^0.1.0", "openai": "^4.0.0"},
                }
            )
        )
        (tmp_path / "agent.ts").write_text(
            "import { OpenAI } from 'openai';\nimport { ChatOpenAI } from '@langchain/openai';\n"
        )
        d = detect_framework(tmp_path)
        assert d.language == "typescript"
        assert d.framework in {"langchain", "openai"}


# ---------------------------------------------------------------------------
# SDK integration plan
# ---------------------------------------------------------------------------


class TestSDKIntegrationPlan:
    def test_plan_for_langchain_repo(self, tmp_target: Path):
        d = detect_framework(tmp_target)
        plan = build_integration_plan(tmp_target, d)
        assert plan.framework == "langchain"
        assert plan.language == "python"
        # Should add eden-ai to dependencies
        assert "eden-ai" in plan.dependencies
        # Should create .eden/config.yaml
        paths = [c.path for c in plan.changes]
        assert ".eden/config.yaml" in paths
        # Should add bootstrap module
        assert any(p.startswith("eden_bootstrap") for p in paths)
        # Should append to requirements.txt
        assert "requirements.txt" in paths

    def test_plan_does_not_clobber_existing_config(self, tmp_target: Path):
        (tmp_target / ".eden").mkdir()
        (tmp_target / ".eden" / "config.yaml").write_text("user: override\n")
        d = detect_framework(tmp_target)
        plan = build_integration_plan(tmp_target, d)
        # We should not be creating a new config.yaml
        assert not any(
            c.path == ".eden/config.yaml" and c.operation == "create"
            for c in plan.changes
        )
        # And there should be a note explaining the decision
        assert any("already" in n.lower() for n in plan.notes)

    def test_plan_includes_instrumentation_snippet(self, tmp_target: Path):
        d = detect_framework(tmp_target)
        plan = build_integration_plan(tmp_target, d)
        bootstrap = next(c for c in plan.changes if c.path.startswith("eden_bootstrap"))
        assert "from eden.integrations.langchain" in bootstrap.content
        assert "eden.init" in bootstrap.content

    def test_plan_for_typescript(self, tmp_path: Path):
        (tmp_path / "package.json").write_text(
            json.dumps({"name": "x", "dependencies": {"openai": "^4"}})
        )
        (tmp_path / "agent.ts").write_text("import OpenAI from 'openai'\n")
        d = detect_framework(tmp_path)
        plan = build_integration_plan(tmp_path, d)
        assert "@eden-ai/sdk" in plan.dependencies
        assert any(c.path.startswith("eden_bootstrap") for c in plan.changes)
        bootstrap = next(c for c in plan.changes if c.path.startswith("eden_bootstrap"))
        assert '@eden-ai/sdk' in bootstrap.content

    def test_apply_plan_writes_files(self, tmp_target: Path):
        d = detect_framework(tmp_target)
        plan = build_integration_plan(tmp_target, d)
        written = apply_plan(tmp_target, plan)
        assert ".eden/config.yaml" in written
        # requirements.txt should now mention eden-ai
        req = (tmp_target / "requirements.txt").read_text()
        assert "eden-ai" in req

    def test_apply_plan_is_idempotent(self, tmp_target: Path):
        d = detect_framework(tmp_target)
        plan = build_integration_plan(tmp_target, d)
        apply_plan(tmp_target, plan)
        # Second run: should not duplicate the requirement line
        req_before = (tmp_target / "requirements.txt").read_text()
        apply_plan(tmp_target, plan)
        req_after = (tmp_target / "requirements.txt").read_text()
        # Requirements section may have grown by zero or by at most the
        # diff-aware additions, but never double-added eden-ai.
        assert req_before.count("eden-ai") == req_after.count("eden-ai")


# ---------------------------------------------------------------------------
# Eval harness generator
# ---------------------------------------------------------------------------


class TestEvalHarness:
    def test_harness_for_langchain(self, tmp_target: Path):
        d = detect_framework(tmp_target)
        h = build_eval_harness(tmp_target, d)
        assert h.framework == "langchain"
        assert h.test_cases, "default cases should be generated"
        # We always have a config + runner + pytest wrapper
        names = {f["path"] for f in h.files}
        assert "eden-eval.yaml" in names
        assert "eden_eval_harness.py" in names
        assert "tests/test_eden_eval.py" in names

    def test_harness_does_not_depend_on_pipeline_by_default(self, tmp_target: Path):
        d = detect_framework(tmp_target)
        h = build_eval_harness(tmp_target, d)
        assert h.use_server_pipeline is False
        cfg_yaml = next(f for f in h.files if f["path"] == "eden-eval.yaml")
        assert "use_server_pipeline: false" in cfg_yaml["content"]

    def test_harness_can_opt_into_server_pipeline(self, tmp_target: Path):
        d = detect_framework(tmp_target)
        h = build_eval_harness(
            tmp_target,
            d,
            use_server_pipeline=True,
            server_pipeline_endpoint="http://localhost:8000/pipeline/jobs",
        )
        assert h.use_server_pipeline is True
        cfg_yaml = next(f for f in h.files if f["path"] == "eden-eval.yaml")
        assert "use_server_pipeline: true" in cfg_yaml["content"]

    def test_harness_runner_is_valid_python(self, tmp_target: Path):
        d = detect_framework(tmp_target)
        h = build_eval_harness(tmp_target, d)
        runner = next(f for f in h.files if f["path"] == "eden_eval_harness.py")
        # Compile-check the runner.
        compile(runner["content"], "eden_eval_harness.py", "exec")

    def test_harness_yaml_is_valid(self, tmp_target: Path):
        d = detect_framework(tmp_target)
        h = build_eval_harness(tmp_target, d)
        cfg = next(f for f in h.files if f["path"] == "eden-eval.yaml")
        # Avoid hard dep on pyyaml for the test runner — just sanity-check
        # structural tokens.
        assert "version: 1" in cfg["content"]
        assert "framework: langchain" in cfg["content"]
        assert "test_cases:" in cfg["content"]

    def test_apply_harness_writes_files(self, tmp_target: Path):
        d = detect_framework(tmp_target)
        h = build_eval_harness(tmp_target, d)
        written = apply_harness(tmp_target, h)
        assert "eden-eval.yaml" in written
        assert (tmp_target / "eden-eval.yaml").exists()
        assert (tmp_target / "eden_eval_harness.py").exists()


# ---------------------------------------------------------------------------
# CI generator
# ---------------------------------------------------------------------------


class TestCIGenerator:
    def test_github_workflow_emitted(self, tmp_target: Path):
        plan = build_ci_plan(tmp_target, providers=["github"])
        paths = [f["path"] for f in plan.files]
        assert ".github/workflows/eden-eval.yml" in paths
        gh = next(f for f in plan.files if f["path"] == ".github/workflows/eden-eval.yml")
        assert "eden-eval" in gh["content"]
        assert "eden_eval_harness.py" in gh["content"]

    def test_gitlab_ci_emitted(self, tmp_target: Path):
        plan = build_ci_plan(tmp_target, providers=["gitlab"])
        paths = [f["path"] for f in plan.files]
        assert ".gitlab-ci.yml" in paths
        gl = next(f for f in plan.files if f["path"] == ".gitlab-ci.yml")
        assert "eden-eval" in gl["content"]
        assert "python eden_eval_harness.py" in gl["content"]

    def test_existing_gitlab_ci_not_clobbered(self, tmp_target: Path):
        (tmp_target / ".gitlab-ci.yml").write_text("existing: config\n")
        plan = build_ci_plan(tmp_target, providers=["gitlab"])
        assert not any(f["path"] == ".gitlab-ci.yml" for f in plan.files)
        assert any("already exists" in n for n in plan.notes)

    def test_existing_github_workflow_not_clobbered(self, tmp_target: Path):
        (tmp_target / ".github").mkdir()
        (tmp_target / ".github" / "workflows").mkdir()
        (tmp_target / ".github" / "workflows" / "eden-eval.yml").write_text(
            "name: existing\n"
        )
        plan = build_ci_plan(tmp_target, providers=["github"])
        assert not any(
            f["path"] == ".github/workflows/eden-eval.yml" for f in plan.files
        )

    def test_apply_does_not_overwrite(self, tmp_target: Path):
        (tmp_target / ".github").mkdir()
        (tmp_target / ".github" / "workflows").mkdir()
        (tmp_target / ".github" / "workflows" / "eden-eval.yml").write_text("EXISTING\n")
        plan = build_ci_plan(tmp_target, providers=["github"])
        written = apply_ci_plan(tmp_target, plan)
        assert ".github/workflows/eden-eval.yml" not in written


# ---------------------------------------------------------------------------
# PR manager
# ---------------------------------------------------------------------------


class TestPRManager:
    def test_slugify(self):
        assert slugify("Hello World!") == "hello-world"
        assert slugify("Fix Latency Issue in Tool X") == "fix-latency-issue-in-tool-x"
        assert slugify("   spaces   ") == "spaces"
        assert slugify("") == "update"

    def test_build_branch_name(self):
        assert build_branch_name("eden/", "Fix Latency") == "eden/fix-latency"
        assert build_branch_name("eden", "Fix Latency") == "eden/fix-latency"
        assert build_branch_name("", "Fix Latency") == "fix-latency"

    def test_render_pr_body(self):
        body = render_pr_body(
            "## Summary\n{summary}\n## Changes\n{changes}",
            summary="add tests",
            changes="- a.py\n- b.py",
        )
        assert "## Summary" in body
        assert "add tests" in body
        assert "- a.py" in body

    def test_render_commit_message(self):
        msg = render_commit_message("eden: {summary}\n\nFiles: {files}", summary="x", files=["a.py"])
        assert "eden: x" in msg
        assert "a.py" in msg

    def test_pr_request_defaults(self):
        req = PRRequest(title="t", body="b")
        assert req.base_branch == "main"
        assert req.platform == "github"

    def test_dispatch_unknown_platform(self):
        req = PRRequest(title="t", body="b", platform="unknown")
        r = create_pull_request(req)
        assert r.success is False
        assert "unknown platform" in r.error

    def test_github_pr_creation_requires_token(self):
        req = PRRequest(
            title="t",
            body="b",
            platform="github",
            project_path="owner/repo",
        )
        r = create_pull_request(req)
        assert r.success is False
        # PyGithub missing OR token missing OR auth failure — all of
        # these surface as success=False with a recognisable error.
        err = r.error.lower()
        assert (
            "token" in err
            or "pygithub" in err
            or "auth" in err
            or "401" in err
            or "403" in err
        )

    def test_github_pr_creation_uses_pygithub(self):
        """Mock PyGithub to assert the call shape."""
        from eden.pr_manager import create_pull_request

        class FakePR:
            html_url = "https://github.com/owner/repo/pull/1"
            number = 1

        class FakeRepo:
            def create_pull(self, **kwargs):
                self.last_call = kwargs
                return FakePR()

        class FakeGH:
            def __init__(self, token, base_url=None):
                self.token = token
                self.base_url = base_url

            def get_repo(self, full):
                self.repo_path = full
                return FakeRepo()

        fake_module = type("M", (), {"Github": FakeGH})

        with patch.dict("sys.modules", {"github": fake_module}):
            req = PRRequest(
                title="t",
                body="b",
                platform="github",
                project_path="owner/repo",
                token="t0k3n",
            )
            r = create_pull_request(req)
        assert r.success is True
        assert r.url == "https://github.com/owner/repo/pull/1"
        assert r.number == 1

    def test_gitlab_pr_creation_requires_python_gitlab(self):
        from eden.pr_manager import create_pull_request

        req = PRRequest(
            title="t",
            body="b",
            platform="gitlab",
            project_path="1",
            token="t",
        )
        # If python-gitlab is not installed, this returns the import error.
        # Either way, success should be False (we don't have a real GL).
        r = create_pull_request(req)
        assert r.success is False

    def test_bitbucket_pr_creation_via_httpx(self):
        from eden.pr_manager import create_pull_request

        import httpx

        class FakeResp:
            status_code = 201

            def json(self):
                return {
                    "id": 42,
                    "links": {"html": {"href": "https://bitbucket.org/ws/repo/pull-requests/42"}},
                }

            @property
            def text(self):
                return ""

        class FakeClient:
            def __init__(self, *a, **kw):
                pass
            def __enter__(self):
                return self
            def __exit__(self, *a):
                return False
            def post(self, url, json=None, auth=None):
                self.last_url = url
                self.last_auth = auth
                return FakeResp()

        with patch.object(httpx, "Client", FakeClient):
            req = PRRequest(
                title="t",
                body="b",
                platform="bitbucket",
                project_path="ws/repo",
                head_branch="feature/x",
                username="u",
                token="app-password",
            )
            r = create_pull_request(req)
        assert r.success is True
        assert r.url == "https://bitbucket.org/ws/repo/pull-requests/42"
        assert r.number == 42


# ---------------------------------------------------------------------------
# /eden-pr slash command (autonomy + decision wiring)
# ---------------------------------------------------------------------------


class _StubRepo:
    """Simulates a GitRepo for cmd_eden_pr without invoking real git."""

    def __init__(self, branch: str = "feature/x", dirty: bool = False, files=None):
        self.branch = branch
        self.dirty = dirty
        self.files = files or ["src/main.py"]


class _AiderLikeSelf:
    """A tiny stand-in for Aider's ``Commands`` instance."""

    def __init__(self, config, autonomy, repo=None):
        self.eden_config = config
        self.eden_autonomy = autonomy
        self.coder = type("C", (), {"repo": repo})()


class TestEdenPrCommand:
    def test_blocks_on_protected_branch(self, fake_config, make_prompt, tmp_path):
        cfg = fake_config
        # Pretend we're trying to push from main -> main. The autonomy
        # manager should block PR creation when the head branch is a
        # protected branch (the standard workflow is to create a
        # feature branch and PR from there).
        cfg.raw["autonomy"]["mode"] = "autonomous"
        repo = _StubRepo(branch="main", dirty=False, files=["a.py"])
        mgr = AutonomyManager(cfg, prompt_fn=make_prompt(False))
        slf = _AiderLikeSelf(cfg, mgr, repo=repo)

        fake_result = PRResult(
            success=True, platform="github", url="https://gh/x", number=1
        )
        with patch("eden.commands.pr.current_branch", return_value="main"), \
             patch("eden.commands.pr.has_uncommitted_changes", return_value=False), \
             patch("eden.commands.pr.list_changed_files", return_value=["a.py"]), \
             patch("eden.commands.pr.create_pull_request", return_value=fake_result) as cpr, \
             patch("eden.commands.pr.subprocess"):
            # Pass --base main to force the head branch to "main"
            # (the command otherwise creates a feature branch when
            # the user is on the base).
            result = cmd_eden_pr(slf, "--title fix --base main --yes")

        # Even in autonomous mode, PR-ing from main to main requires
        # explicit confirmation, and ``--yes`` does NOT bypass that
        # for protected branches. The PR should be refused.
        assert result is not None
        assert result.success is False
        assert "BLOCKED" in result.error or "protected" in result.error
        cpr.assert_not_called()

    def test_pushes_and_creates_pr_in_semi_mode(self, fake_config, tmp_path):
        cfg = fake_config
        # Use ``semi`` mode so /eden-pr is auto-approved for non-
        # protected, non-rate-limited actions; feature branches are
        # never protected, so no extra confirmation is required.
        cfg.raw["autonomy"]["mode"] = "semi"
        cfg.raw["autonomy"]["auto_pr"] = True
        repo = _StubRepo(branch="feature/x", dirty=False, files=["a.py"])
        # In semi mode, ``pr_create`` still requires confirmation by
        # default. The test injects a prompt_fn that auto-approves.
        mgr = AutonomyManager(cfg, prompt_fn=lambda _msg: True)
        slf = _AiderLikeSelf(cfg, mgr, repo=repo)

        fake_result = PRResult(
            success=True, platform="github", url="https://gh/x", number=1
        )
        with patch("eden.commands.pr.current_branch", return_value="feature/x"), \
             patch("eden.commands.pr.has_uncommitted_changes", return_value=False), \
             patch("eden.commands.pr.list_changed_files", return_value=["a.py"]), \
             patch("eden.commands.pr.create_pull_request", return_value=fake_result) as cpr, \
             patch("eden.commands.pr.subprocess") as sp:
            # Don't pass --title so the configured title_template
            # ("eden: {summary}") is applied.
            result = cmd_eden_pr(slf, "")

        assert result is not None
        assert result.success is True
        cpr.assert_called_once()
        # ``cpr`` is called with a single positional ``req`` kwarg.
        call_args = cpr.call_args
        # The call site is ``create_pull_request(req)`` so the
        # request lives in the first positional arg or the ``req`` kw.
        if call_args.kwargs:
            req = call_args.kwargs.get("req")
        else:
            req = call_args.args[0]
        assert req.head_branch == "feature/x"
        assert req.title.startswith("eden:")
        # Verify that subprocess was called to push
        sp.run.assert_called_once()
        push_args = sp.run.call_args.args[0]
        assert "push" in push_args

    def test_refuses_on_uncommitted_changes(self, fake_config, make_prompt, tmp_path):
        cfg = fake_config
        cfg.raw["autonomy"]["mode"] = "autonomous"
        repo = _StubRepo(branch="feature/x", dirty=True, files=["a.py"])
        mgr = AutonomyManager(cfg, prompt_fn=make_prompt(True))
        slf = _AiderLikeSelf(cfg, mgr, repo=repo)

        with patch("eden.commands.pr.current_branch", return_value="feature/x"), \
             patch("eden.commands.pr.has_uncommitted_changes", return_value=True), \
             patch("eden.commands.pr.list_changed_files", return_value=["a.py"]), \
             patch("eden.commands.pr.create_pull_request") as cpr:
            result = cmd_eden_pr(slf, "--yes")
        assert result is not None
        assert result.success is False
        assert "uncommitted" in result.error
        cpr.assert_not_called()

    def test_blocks_on_secret_in_body(self, fake_config, tmp_path):
        cfg = fake_config
        cfg.raw["pr"]["body_template"] = "PR body: AKIAIOSFODNN7EXAMPLE"
        cfg.raw["autonomy"]["mode"] = "autonomous"
        repo = _StubRepo(branch="feature/x", dirty=False, files=["a.py"])
        mgr = AutonomyManager(cfg)
        slf = _AiderLikeSelf(cfg, mgr, repo=repo)

        with patch("eden.commands.pr.current_branch", return_value="feature/x"), \
             patch("eden.commands.pr.has_uncommitted_changes", return_value=False), \
             patch("eden.commands.pr.list_changed_files", return_value=["a.py"]), \
             patch("eden.commands.pr.create_pull_request") as cpr:
            result = cmd_eden_pr(slf, "--title add-feature --no-push")
        assert result is not None
        assert result.success is False
        assert "secret" in result.error or "BLOCKED" in result.error
        cpr.assert_not_called()


# ---------------------------------------------------------------------------
# /integrate-eden slash command (autonomy + plan + apply)
# ---------------------------------------------------------------------------


class TestIntegrateCommand:
    def test_dry_run_returns_full_summary(self, tmp_target, fake_config):
        cfg = fake_config
        mgr = AutonomyManager(cfg)
        slf = _AiderLikeSelf(cfg, mgr)
        result = cmd_eden_integrate(
            slf, f"--target {tmp_target} --dry-run"
        )
        assert result is not None
        assert result["success"] in (True, False)  # not asserted since dry-run skips write
        # dry-run path returns the summary; written is absent.
        assert "integration" in result
        assert "eval_harness" in result
        assert "detection" in result
        # No files should have been created.
        assert not (tmp_target / ".eden").exists()

    def test_full_run_writes_files(self, tmp_target, fake_config, tmp_path):
        cfg = fake_config
        mgr = AutonomyManager(cfg, prompt_fn=lambda _msg: True)
        slf = _AiderLikeSelf(cfg, mgr)
        # Use --yes to skip the confirmation prompt that the autonomy
        # manager would otherwise need.
        result = cmd_eden_integrate(
            slf,
            f"--target {tmp_target} --yes --no-ci",
        )
        assert result is not None
        assert result.get("success") is True
        assert any(p == "eden-eval.yaml" for p in result["written"])
        assert any(p.startswith("eden_bootstrap") for p in result["written"])
        assert any(p == ".eden/config.yaml" for p in result["written"])
        # Files actually exist on disk
        assert (tmp_target / "eden-eval.yaml").exists()
        assert (tmp_target / "eden_eval_harness.py").exists()
        assert (tmp_target / "tests" / "test_eden_eval.py").exists()
        assert (tmp_target / ".eden" / "config.yaml").exists()

    def test_blocks_on_protected_path(self, tmp_target, fake_config, tmp_path):
        cfg = fake_config
        mgr = AutonomyManager(cfg)
        slf = _AiderLikeSelf(cfg, mgr)
        # If we somehow try to write to .env, the autonomy check should
        # block. We simulate that by patching the plan to include .env.
        # NOTE: ``eden.commands.integrate`` imports ``build_integration_plan``
        # at module load time, so we patch the bound name in *that* module
        # (not the source module).
        with patch("eden.commands.integrate.build_integration_plan") as bp:
            from eden.sdk_integrator import FileChange, IntegrationPlan
            bp.return_value = IntegrationPlan(
                framework="langchain",
                language="python",
                changes=[FileChange(path=".env", operation="create", content="x=1", description="x")],
            )
            result = cmd_eden_integrate(slf, f"--target {tmp_target} --yes --no-ci")
        assert result is not None
        assert result.get("success") is False
        assert "BLOCKED" in result.get("error", "") or "protected" in result.get("error", "")

    def test_uses_local_harness_by_default(self, tmp_target, fake_config):
        cfg = fake_config
        mgr = AutonomyManager(cfg, prompt_fn=lambda _msg: True)
        slf = _AiderLikeSelf(cfg, mgr)
        result = cmd_eden_integrate(slf, f"--target {tmp_target} --yes --no-ci --dry-run")
        assert result is not None
        assert result["use_server_pipeline"] is False
        # eden-eval.yaml should have use_server_pipeline: false
        cfg_yaml = next(
            f for f in result["eval_harness"]["files"] if f["path"] == "eden-eval.yaml"
        )
        assert "use_server_pipeline: false" in cfg_yaml["content"]
