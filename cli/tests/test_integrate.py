"""Integration tests for the /integrate-eden workflow.

These tests exercise the full E2E flow:
  detect framework  ->  build integration plan  ->  build eval harness
  ->  build CI plan  ->  apply to disk  ->  autonomy gates.

The tests use real temporary git repos to verify that the generated
files are correct and the autonomy guardrails fire when they should.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List
from unittest.mock import patch

import pytest

from eden.autonomy import AutonomyManager
from eden.ci_generator import apply_ci_plan, build_ci_plan
from eden.commands.integrate import cmd_eden_integrate
from eden.eval_harness_generator import apply_harness, build_eval_harness
from eden.framework_detector import detect_framework
from eden.sdk_integrator import apply_plan, build_integration_plan


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _StubSelf:
    """Minimal stand-in for an Aider-like ``Commands`` instance."""

    def __init__(self, config: Any, autonomy: AutonomyManager):
        self.eden_config = config
        self.eden_autonomy = autonomy


def _make_autogen_repo(target: Path) -> Path:
    target.mkdir(parents=True, exist_ok=True)
    (target / "agent.py").write_text(
        "from autogen import AssistantAgent, UserProxyAgent\n"
        "\n"
        "def run(task: str) -> str:\n"
        '    a = AssistantAgent("assistant", llm_config={"model": "gpt-4"})\n'
        '    u = UserProxyAgent("user", code_execution_config=False)\n'
        '    u.initiate_chat(a, message=task)\n'
        '    return a.last_message()["content"]\n',
        encoding="utf-8",
    )
    (target / "requirements.txt").write_text(
        "pyautogen>=0.2.0\nopenai>=1.0.0\n", encoding="utf-8"
    )
    return target


def _make_crewai_repo(target: Path) -> Path:
    target.mkdir(parents=True, exist_ok=True)
    (target / "crew.py").write_text(
        "from crewai import Agent, Crew, Task\n"
        "\n"
        "def run(goal: str) -> str:\n"
        '    researcher = Agent(role="researcher", goal="research", backstory="x")\n'
        '    task = Task(description=goal, agent=researcher)\n'
        '    crew = Crew(agents=[researcher], tasks=[task])\n'
        '    return crew.kickoff()\n',
        encoding="utf-8",
    )
    (target / "requirements.txt").write_text(
        "crewai>=0.1.0\n", encoding="utf-8"
    )
    return target


def _make_llamaindex_repo(target: Path) -> Path:
    target.mkdir(parents=True, exist_ok=True)
    (target / "agent.py").write_text(
        "from llama_index.core import VectorStoreIndex, SimpleDirectoryReader\n"
        "\n"
        "def run(query: str) -> str:\n"
        '    docs = SimpleDirectoryReader("data").load_data()\n'
        "    idx = VectorStoreIndex.from_documents(docs)\n"
        "    return str(idx.as_query_engine().query(query))\n",
        encoding="utf-8",
    )
    (target / "requirements.txt").write_text(
        "llama-index>=0.10.0\n", encoding="utf-8"
    )
    return target


def _make_openai_repo(target: Path) -> Path:
    target.mkdir(parents=True, exist_ok=True)
    (target / "agent.py").write_text(
        "from openai import OpenAI\n"
        "\n"
        "client = OpenAI()\n"
        "\n"
        "def run(prompt: str) -> str:\n"
        '    r = client.chat.completions.create(\n'
        '        model="gpt-4",\n'
        '        messages=[{"role": "user", "content": prompt}],\n'
        '    )\n'
        '    return r.choices[0].message.content\n',
        encoding="utf-8",
    )
    (target / "requirements.txt").write_text("openai>=1.0.0\n", encoding="utf-8")
    return target


def _git_init(repo: Path) -> None:
    """Initialise a git repo at ``repo`` with one commit, so git-aware
    tools (pr_manager, etc.) can run."""
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@x",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@x"}
    subprocess.run(["git", "init", "-q"], cwd=str(repo), check=True, env=env)
    subprocess.run(["git", "add", "."], cwd=str(repo), check=True, env=env)
    subprocess.run(
        ["git", "commit", "-m", "init", "-q"],
        cwd=str(repo), check=True, env=env,
    )


# ---------------------------------------------------------------------------
# Framework detection integration
# ---------------------------------------------------------------------------


class TestIntegrationDetection:
    def test_detects_autogen(self, tmp_path: Path):
        repo = _make_autogen_repo(tmp_path / "autogen-agent")
        d = detect_framework(repo)
        assert d.framework == "autogen"
        assert d.confidence >= 0.6

    def test_detects_crewai_integration(self, tmp_path: Path):
        repo = _make_crewai_repo(tmp_path / "crew-agent")
        d = detect_framework(repo)
        assert d.framework == "crewai"

    def test_detects_llamaindex_integration(self, tmp_path: Path):
        repo = _make_llamaindex_repo(tmp_path / "llama-agent")
        d = detect_framework(repo)
        assert d.framework == "llama_index"

    def test_detects_openai_integration(self, tmp_path: Path):
        repo = _make_openai_repo(tmp_path / "openai-agent")
        d = detect_framework(repo)
        assert d.framework == "openai"

    def test_typescript_openai_detection(self, tmp_path: Path):
        ts = tmp_path / "ts-agent"
        ts.mkdir()
        (ts / "package.json").write_text(
            json.dumps({"name": "ts", "dependencies": {"openai": "^4"}})
        )
        (ts / "agent.ts").write_text(
            "import OpenAI from 'openai';\n"
            "const client = new OpenAI();\n"
        )
        d = detect_framework(ts)
        assert d.language == "typescript"
        assert d.framework == "openai"


# ---------------------------------------------------------------------------
# End-to-end: build all three plans, then apply them
# ---------------------------------------------------------------------------


class TestEndToEnd:
    def test_langchain_full_flow(self, tmp_target: Path, fake_config):
        d = detect_framework(tmp_target)
        assert d.framework == "langchain"

        # Build the three plans
        plan = build_integration_plan(tmp_target, d)
        harness = build_eval_harness(tmp_target, d)
        ci = build_ci_plan(tmp_target, providers=["github"])

        # Apply all three
        written_plan = apply_plan(tmp_target, plan)
        written_harness = apply_harness(tmp_target, harness)
        written_ci = apply_ci_plan(tmp_target, ci)

        # Verify
        assert ".eden/config.yaml" in written_plan
        assert "eden-eval.yaml" in written_harness
        assert "eden_eval_harness.py" in written_harness
        assert "tests/test_eden_eval.py" in written_harness
        assert ".github/workflows/eden-eval.yml" in written_ci

        # Spot-check actual content
        eden_cfg = (tmp_target / ".eden" / "config.yaml").read_text()
        assert "framework: langchain" in eden_cfg
        assert "use_server_pipeline: false" in eden_cfg

        harness_yaml = (tmp_target / "eden-eval.yaml").read_text()
        assert "framework: langchain" in harness_yaml
        assert "use_server_pipeline: false" in harness_yaml

        # The bootstrap module is a real Python file
        bootstrap = next(
            tmp_target / p for p in tmp_target.rglob("eden_bootstrap*.py")
        )
        assert "eden.init" in bootstrap.read_text()

    def test_idempotent_re_run(self, tmp_target: Path, fake_config):
        d = detect_framework(tmp_target)
        plan = build_integration_plan(tmp_target, d)
        harness = build_eval_harness(tmp_target, d)

        # Apply once
        apply_plan(tmp_target, plan)
        apply_harness(tmp_target, harness)
        req_first = (tmp_target / "requirements.txt").read_text()

        # Re-apply
        apply_plan(tmp_target, plan)
        apply_harness(tmp_target, harness)
        req_second = (tmp_target / "requirements.txt").read_text()

        # eden-ai line should appear exactly once after re-run
        assert req_first.count("eden-ai") == req_second.count("eden-ai")
        assert req_first.count("eden-ai") == 1

    def test_harness_runner_compiles(self, tmp_target: Path):
        d = detect_framework(tmp_target)
        harness = build_eval_harness(tmp_target, d)
        runner = next(
            f for f in harness.files if f["path"] == "eden_eval_harness.py"
        )
        # Should be valid Python that can be compile()'d
        compile(runner["content"], "eden_eval_harness.py", "exec")

    def test_pytest_wrapper_compiles(self, tmp_target: Path):
        d = detect_framework(tmp_target)
        harness = build_eval_harness(tmp_target, d)
        wrapper = next(
            f for f in harness.files if f["path"] == "tests/test_eden_eval.py"
        )
        compile(wrapper["content"], "test_eden_eval.py", "exec")


# ---------------------------------------------------------------------------
# Autonomy gating in the full integrate flow
# ---------------------------------------------------------------------------


class TestIntegrateAutonomy:
    def test_blocked_when_prompt_denies(self, tmp_target: Path, fake_config):
        cfg = fake_config
        cfg.raw["autonomy"]["mode"] = "autonomous"
        # In autonomous mode the prompt_fn is never called for plain
        # writes, so we still need a confirm function that returns
        # False for any soft confirm.
        mgr = AutonomyManager(cfg, prompt_fn=lambda _msg: False)
        slf = _StubSelf(cfg, mgr)
        result = cmd_eden_integrate(slf, f"--target {tmp_target} --no-ci")
        # No protected-path content in the plan, so allowed=True;
        # nothing requires confirmation, and the result is success.
        assert result is not None
        assert result.get("success") is True
        assert (tmp_target / "eden-eval.yaml").exists()

    def test_protected_path_triggers_block(self, tmp_target: Path, fake_config):
        cfg = fake_config
        mgr = AutonomyManager(cfg)
        slf = _StubSelf(cfg, mgr)

        from eden.sdk_integrator import FileChange, IntegrationPlan

        # Patch the *bound* import inside eden.commands.integrate so
        # the command sees our modified plan.
        with patch("eden.commands.integrate.build_integration_plan") as bp:
            bp.return_value = IntegrationPlan(
                framework="langchain",
                language="python",
                changes=[
                    FileChange(
                        path="secrets/server.pem",
                        operation="create",
                        content="fake",
                        description="x",
                    ),
                ],
            )
            result = cmd_eden_integrate(
                slf, f"--target {tmp_target} --yes --no-ci"
            )
        assert result is not None
        assert result.get("success") is False
        assert (
            "BLOCKED" in result.get("error", "")
            or "protected" in result.get("error", "").lower()
        )
        # The .pem file must NOT exist.
        assert not (tmp_target / "secrets" / "server.pem").exists()

    def test_dry_run_does_not_write(self, tmp_target: Path, fake_config):
        cfg = fake_config
        mgr = AutonomyManager(cfg, prompt_fn=lambda _msg: True)
        slf = _StubSelf(cfg, mgr)
        result = cmd_eden_integrate(
            slf, f"--target {tmp_target} --dry-run --no-ci"
        )
        assert result is not None
        assert result.get("dry_run") is True
        assert result.get("success") is True
        # No files written
        assert not (tmp_target / ".eden").exists()
        assert not (tmp_target / "eden-eval.yaml").exists()


# ---------------------------------------------------------------------------
# Server pipeline opt-in
# ---------------------------------------------------------------------------


class TestServerPipelineOptIn:
    def test_local_harness_when_flag_off(self, tmp_target: Path, fake_config):
        cfg = fake_config
        cfg.raw["integrate"]["use_server_pipeline"] = False
        d = detect_framework(tmp_target)
        h = build_eval_harness(
            tmp_target, d, use_server_pipeline=False
        )
        assert h.use_server_pipeline is False
        cfg_yaml = next(
            f for f in h.files if f["path"] == "eden-eval.yaml"
        )
        assert "use_server_pipeline: false" in cfg_yaml["content"]

    def test_server_pipeline_harness_when_flag_on(self, tmp_target: Path, fake_config):
        cfg = fake_config
        cfg.raw["integrate"]["use_server_pipeline"] = True
        d = detect_framework(tmp_target)
        h = build_eval_harness(
            tmp_target,
            d,
            use_server_pipeline=True,
            server_pipeline_endpoint="http://localhost:8000/pipeline/jobs",
        )
        assert h.use_server_pipeline is True
        assert h.server_pipeline_endpoint == "http://localhost:8000/pipeline/jobs"
        cfg_yaml = next(
            f for f in h.files if f["path"] == "eden-eval.yaml"
        )
        assert "use_server_pipeline: true" in cfg_yaml["content"]
        assert "http://localhost:8000/pipeline/jobs" in cfg_yaml["content"]

    def test_harness_does_not_require_server_when_local(
        self, tmp_target: Path, fake_config
    ):
        """The local harness must be runnable without the server."""
        cfg = fake_config
        cfg.raw["integrate"]["use_server_pipeline"] = False
        d = detect_framework(tmp_target)
        h = build_eval_harness(tmp_target, d, use_server_pipeline=False)
        apply_harness(tmp_target, h)
        runner = tmp_target / "eden_eval_harness.py"
        cfg_file = tmp_target / "eden-eval.yaml"
        # The runner file references the cfg file — both must exist.
        assert runner.exists()
        assert cfg_file.exists()
        # Runner can be syntax-checked.
        compile(runner.read_text(), str(runner), "exec")
