"""`/eden-pr` slash command.

Implements the Aider ``cmd_*`` method convention so the auto-discovery
loop in ``aider/commands.py`` picks it up automatically. Builds a PR
body from ``.eden/config.yaml`` templates, picks a branch name with
the configured prefix, and dispatches to the right backend
(GitHub / GitLab / Bitbucket) via :mod:`eden.pr_manager`.

The command *intentionally* does not push the branch itself — the
caller (C1 chat loop) is expected to push via Aider's git plumbing so
pushes go through any other guardrails that C1 wires up.
"""

from __future__ import annotations

import argparse
import shlex
import subprocess  # nosec
import sys
from typing import Any, List, Optional

from eden.autonomy import AutonomyManager
from eden.pr_manager import (
    PRRequest,
    PRResult,
    build_branch_name,
    create_pull_request,
    current_branch,
    has_uncommitted_changes,
    list_changed_files,
    render_commit_message,
    render_pr_body,
)


def _parse_args(args: str) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="/eden-pr",
        description="Create a pull request from the current changes",
    )
    parser.add_argument("--title", help="Override the PR title")
    parser.add_argument("--body", help="Override the PR body")
    parser.add_argument("--base", help="Override the base branch (default from config)")
    parser.add_argument("--draft", action="store_true", help="Create as a draft PR")
    parser.add_argument(
        "--remote", help="Override the configured remote (default from config)"
    )
    parser.add_argument(
        "--no-push",
        action="store_true",
        help="Do not push the branch before creating the PR",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Skip the autonomy confirmation prompt",
    )
    return parser.parse_args(shlex.split(args) if args else [])


def _resolve_config(config: Any) -> dict:
    section = config.get_section("pr") if hasattr(config, "get_section") else {}
    return section


def _print(msg: str) -> None:
    """Print to stdout in a way that tests can patch out."""
    print(msg, file=sys.stdout)


def _print_err(msg: str) -> None:
    print(msg, file=sys.stderr)


def cmd_eden_pr(self: Any, args: str) -> Optional[PRResult]:
    """The ``/eden-pr`` slash command.

    The ``self`` argument is the Aider ``Commands`` instance (when
    wired into the chat loop). We only access ``self.coder`` for
    repo/git plumbing; in isolation (C2 tests) ``self`` is a stub.
    """
    config = getattr(self, "eden_config", None) or _StubConfig()
    autonomy: AutonomyManager = (
        getattr(self, "eden_autonomy", None)
        or AutonomyManager(config, prompt_fn=_StubConfig.prompt)
    )

    ns = _parse_args(args)
    pr_cfg = _resolve_config(config)

    # Resolve branch
    try:
        current = current_branch()
    except RuntimeError as exc:
        _print_err(f"[eden-pr] {exc}")
        return PRResult(success=False, platform=pr_cfg.get("platform", "github"), error=str(exc))

    base = ns.base or pr_cfg.get("base_branch", "main")
    summary = ns.title or "update"
    prefix = pr_cfg.get("branch_prefix", "eden/")

    # If the user is on a protected branch (main/master/release/...)
    # and the base is the same, refuse outright. They need to checkout
    # a feature branch first. The autonomy manager will also flag
    # this, but checking up-front gives a clearer error message.
    protected_branches = {"main", "master", "release", "production"}
    if current in protected_branches and current == base:
        _print_err(
            f"[eden-pr] refusing to create a PR from protected branch "
            f"{current!r} onto itself. Checkout a feature branch first."
        )
        return PRResult(
            success=False,
            platform=pr_cfg.get("platform", "github"),
            error=f"BLOCKED: refusing to PR from protected branch {current!r} onto itself",
        )

    head_branch = current if current != base else build_branch_name(prefix, summary)

    if head_branch == base:
        _print_err(
            f"[eden-pr] refusing to create a PR from {base!r} onto itself. "
            "Checkout a feature branch first."
        )
        return PRResult(
            success=False,
            platform=pr_cfg.get("platform", "github"),
            error="head branch equals base branch",
        )

    # Uncommitted changes?
    try:
        dirty = has_uncommitted_changes()
    except RuntimeError:
        dirty = False
    if dirty:
        _print_err(
            "[eden-pr] you have uncommitted changes. Commit or stash them "
            "before opening a PR."
        )
        return PRResult(
            success=False,
            platform=pr_cfg.get("platform", "github"),
            error="uncommitted changes",
        )

    # PR body. Resolution:
    #   1. Explicit --body flag wins.
    #   2. Otherwise, if config provides a non-empty body_template,
    #      render it (with safe format_map — missing keys left blank).
    #   3. Otherwise, fall back to the default template.
    if ns.body:
        body = ns.body
    else:
        body_template = pr_cfg.get("body_template") or ""
        changes_str = (
            "\n".join(f"- {f}" for f in list_changed_files())
            or "- _no file changes detected_"
        )
        if body_template:
            body = render_pr_body(
                body_template,
                summary=summary,
                changes=changes_str,
            )
        else:
            body = render_pr_body(
                "",
                summary=summary,
                changes=changes_str,
            )

    # Apply the configured title template. If the user passed
    # ``--title`` we still wrap it through the template if it doesn't
    # already start with the configured prefix. If the title is fully
    # custom we respect it as-is.
    title_template = pr_cfg.get("title_template", "eden: {summary}")
    if ns.title:
        title = ns.title
    else:
        title = title_template.format(summary=summary)
    draft = ns.draft or bool(pr_cfg.get("draft_by_default"))

    # Commit message (for the optional commit step)
    commit_template = pr_cfg.get("commit_template", "eden: {summary}")
    commit_msg = render_commit_message(commit_template, summary=summary, files=list_changed_files())

    # Build the PRRequest
    req = PRRequest(
        title=title,
        body=body,
        base_branch=base,
        head_branch=head_branch,
        draft=draft,
        reviewers=list(pr_cfg.get("default_reviewers", [])),
        labels=list(pr_cfg.get("default_labels", [])),
        platform=pr_cfg.get("platform", "github"),
        remote=ns.remote or pr_cfg.get("remote", "origin"),
        commit_message=commit_msg,
    )

    # Autonomy gate. We pass the head_branch (the source) through
    # the autonomy check. The base branch is checked separately via
    # the early-return above; PRing *into* a protected branch is
    # normal workflow, but the head branch is what we gate on.
    decision = autonomy.check_action(
        "pr_create",
        branch=head_branch,
        content_samples=[title, body],
    )
    if not decision.allowed:
        reason = f"BLOCKED: {decision.reason}"
        _print_err(f"[eden-pr] {reason}")
        return PRResult(
            success=False,
            platform=req.platform,
            error=reason,
        )
    if decision.requires_confirmation and not ns.yes:
        msg = (
            f"Open a {req.platform} PR '{title}' from {head_branch} -> {base}? "
            f"[Findings: {[f.to_dict() for f in decision.findings]}]"
        )
        if not autonomy.confirm(decision, msg):
            _print_err("[eden-pr] cancelled by user")
            return PRResult(
                success=False,
                platform=req.platform,
                error="cancelled by user",
            )

    # Push the branch (unless --no-push). C1's chat loop will normally
    # have already pushed; in the CLI-only path we push here.
    if not ns.no_push:
        try:
            subprocess.run(  # nosec
                ["git", "push", "-u", req.remote, head_branch],
                check=True,
                timeout=60,
            )
        except subprocess.CalledProcessError as exc:
            return PRResult(
                success=False,
                platform=req.platform,
                error=f"git push failed: {exc}",
            )

    # Dispatch
    result = create_pull_request(req)
    autonomy.record_invocation("pr_create")

    if result.success:
        _print(f"[eden-pr] PR opened: {result.url}")
    else:
        _print_err(f"[eden-pr] PR creation failed: {result.error}")

    return result


# ---------------------------------------------------------------------------
# Test stub: a config with prompt_fn that auto-approves in tests.
# ---------------------------------------------------------------------------


class _StubConfig:
    """Minimal config stub used when ``self.eden_config`` is not wired."""

    raw: dict = {
        "pr": {
            "platform": "github",
            "remote": "origin",
            "base_branch": "main",
            "branch_prefix": "eden/",
            "default_reviewers": [],
            "default_labels": ["eden"],
            "draft_by_default": False,
            "title_template": "eden: {summary}",
            "commit_template": "eden: {summary}",
        },
        "autonomy": {"mode": "approval", "auto_pr": False},
        "rate_limits": {"pipeline_invocations_per_hour": 5},
    }

    def get_section(self, name: str) -> dict:
        return dict(self.raw.get(name, {}))

    @staticmethod
    def prompt(message: str) -> bool:  # pragma: no cover - test util
        """Test-only default: deny. Tests inject their own prompt."""
        return False
