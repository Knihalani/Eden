"""Fixtures for the golden-path harness (plan M1).

Deterministic and offline by construction:

* Postgres — the suite-wide autouse ``patch_postgres`` MagicMock fake
  (tests/conftest.py:425) is re-pointed at a stateful in-memory
  :class:`FakeLoopDB`, so the *real* production write paths (state
  machine, verify scheduler, plans repo, self-heal executor) run their
  real SQL against needle-matched in-memory tables.
* Git / PRs — a real ``git init`` repo per test with
  ``EDEN_PR_PROVIDER=local`` so ``LocalRepoProvider``/``LocalPRProvider``
  are used and approved PRs land as ``.eden/prs/<n>.json``
  (pattern: tests/integration/test_cat23_patch_pr_flow.py).
* Redis / event bus — no Redis; ``publish`` is patched to a capture
  list. Tests feed captured events back into the orchestrator to drive
  the loop deterministically.
* LLMs — faked at the same seams the existing unit suites use
  (``eden.autonomous.InvestigationAgent`` for triage,
  ``PatchGenerator.generate`` for diffs).
"""

from __future__ import annotations

import json
import subprocess
import tempfile
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import pytest

GIT = "/usr/bin/git"

ORG = "org-golden"
AGENT = "repo-golden"
BUGGY_FILE = "agent/checkout.py"
BUGGY_CONTENT = "def checkout(total):\n    return total / 0  # BUG\n"
FIXED_CONTENT = "def checkout(total):\n    return total\n"
SAMPLE_DIFF = (
    "--- a/agent/checkout.py\n"
    "+++ b/agent/checkout.py\n"
    "@@ -1,2 +1,2 @@\n"
    " def checkout(total):\n"
    "-    return total / 0  # BUG\n"
    "+    return total\n"
)
FINGERPRINT = "fp-golden-checkout"


def _run_git(*args: str, cwd: Path) -> str:
    result = subprocess.run(
        [GIT, *args], cwd=cwd, capture_output=True, text=True, check=True
    )
    return result.stdout.strip()


@pytest.fixture
def temp_git_repo() -> Path:
    """Real git repo seeded with the known-buggy file (cat23 pattern)."""
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        _run_git("init", "-q", "--initial-branch=main", cwd=repo)
        _run_git("config", "user.email", "test@eden.local", cwd=repo)
        _run_git("config", "user.name", "Eden Test", cwd=repo)
        buggy = repo / BUGGY_FILE
        buggy.parent.mkdir(parents=True, exist_ok=True)
        buggy.write_text(BUGGY_CONTENT)
        _run_git("add", BUGGY_FILE, cwd=repo)
        _run_git("commit", "-q", "-m", "initial (buggy)", cwd=repo)
        yield repo


@pytest.fixture
def local_providers(temp_git_repo: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Force LocalRepoProvider/LocalPRProvider at the factory seam."""
    monkeypatch.setenv("EDEN_PR_PROVIDER", "local")
    monkeypatch.setenv("EDEN_LOCAL_REPO_PATH", str(temp_git_repo))
    return temp_git_repo


class FakeLoopDB:
    """Stateful needle-routed stand-in for the loop's Postgres tables.

    Installed onto the suite's MagicMock PostgresClient so the real
    production SQL call sites run unchanged. Unknown queries return the
    same defaults as the base fake (None / [] / "OK").
    """

    def __init__(self) -> None:
        self.issues: dict[str, dict[str, Any]] = {}
        self.stumbles: list[dict[str, Any]] = []
        #: fingerprint -> recent count used by count_recent_stumbles.
        self.recent_stumbles: dict[str, int] = {}
        #: wildcard count returned for ANY fingerprint when not None
        #: (verify rows may carry a ref, not the issue fingerprint).
        self.recent_stumbles_any: int | None = None
        self.plans: dict[str, dict[str, Any]] = {}
        self.verifications: dict[str, dict[str, Any]] = {}  # issue_id -> row
        self.transitions: list[dict[str, Any]] = []
        self.audits: list[dict[str, Any]] = []
        self.heal_actions: dict[str, dict[str, Any]] = {}
        self.canaries: dict[str, dict[str, Any]] = {}
        self.policy_row: dict[str, Any] | None = None
        self.repo_connection: dict[str, Any] | None = None

    # ── seed helpers ────────────────────────────────────────────────

    def seed_issue(
        self,
        issue_id: str = "11111111-1111-1111-1111-111111111111",
        *,
        status: str = "open",
        severity: str = "p1",
        kind: str = "tool_error",
        fingerprint: str = FINGERPRINT,
        stumble_count: int = 6,
        triage_result: dict[str, Any] | None = None,
    ) -> str:
        self.issues[issue_id] = {
            "id": issue_id,
            "org_id": ORG,
            "fingerprint": fingerprint,
            "kind": kind,
            "title": "checkout crashes with ZeroDivisionError",
            "status": status,
            "severity": severity,
            "agent_id": AGENT,
            "stumble_count": stumble_count,
            "user_count": 2,
            "repetition_count": 1,
            "affected_user_ids": [],
            "example_stumble_ids": [],
            "triage_result": triage_result,
        }
        return issue_id

    def seed_stumbles(
        self,
        n: int,
        *,
        kind: str = "tool_error",
        fingerprint: str = FINGERPRINT,
        detail: dict[str, Any] | None = None,
    ) -> None:
        for i in range(n):
            self.stumbles.append(
                {
                    "id": str(uuid.uuid4()),
                    "org_id": ORG,
                    "trace_id": f"trace-{fingerprint}-{i}",
                    "session_id": None,
                    "user_id": f"user-{i % 2}",
                    "agent_id": AGENT,
                    "span_id": None,
                    "kind": kind,
                    "fingerprint": fingerprint,
                    "title": f"stumble {i} ({kind})",
                    "detail": detail or {"error": "ZeroDivisionError", "file": BUGGY_FILE},
                    "severity": "p1",
                    "detected_by": "golden_path",
                    "detected_at": datetime.now(UTC),
                }
            )

    def seed_policy(self, **overrides: Any) -> None:
        """autonomy_policies row; kwargs override the policy JSON."""
        policy = {"maintenance_mode": "assisted", "auto_runtime_heal": True}
        policy.update(overrides)
        self.policy_row = {"policy": policy, "compliance_profile": "standard"}

    def seed_canary(self, canary_id: str = "canary-1") -> str:
        self.canaries[canary_id] = {
            "id": canary_id,
            "name": "checkout-prompt",
            "status": "active",
            "current_version": 3,
            "created_at": datetime.now(UTC),
        }
        return canary_id

    def seed_repo_connection(self, repo_path: str) -> None:
        self.repo_connection = {
            "installation_id": None,
            "repo_full_name": repo_path,
            "default_branch": "main",
            "provider": "local",
            "id": "",
            "org_id": ORG,
            "status": "active",
            "agent_id": AGENT,
        }

    def seed_plan(
        self,
        plan_id: str = "22222222-2222-2222-2222-222222222222",
        *,
        status: str = "draft",
        plan_kind: str = "code_patch",
        diff_unified: str | None = SAMPLE_DIFF,
        issue_id: str = "11111111-1111-1111-1111-111111111111",
        parent_plan_id: str | None = None,
        pr_number: int | None = None,
    ) -> str:
        self.plans[plan_id] = {
            "id": plan_id,
            "org_id": ORG,
            "run_id": None,
            "agent_id": AGENT,
            "plan_kind": plan_kind,
            "status": status,
            "title": "Fix checkout ZeroDivisionError",
            "summary": "patch the divide-by-zero",
            "source_ref": f"issue:{issue_id}",
            "source_fingerprint": f"issue:{issue_id}",
            "diff_unified": diff_unified,
            "files_changed": json.dumps([BUGGY_FILE]),
            "evidence": json.dumps({"issue_id": issue_id}),
            "triage_snapshot": None,
            "estimated_blast_radius": None,
            "llm_cost_usd": 0.1,
            "parent_plan_id": parent_plan_id,
            "pr_url": None,
            "pr_number": pr_number,
            "github_branch": None,
        }
        return plan_id

    # ── query routers ───────────────────────────────────────────────

    async def fetchrow(self, query: str, *args: Any) -> dict[str, Any] | None:
        q = " ".join(query.split())
        if "FROM agent_issues WHERE org_id = $1 AND id = $2::uuid" in q:
            row = self.issues.get(str(args[1]))
            return dict(row) if row else None
        if "FROM agent_issues" in q and "fingerprint = $2" in q:
            for row in self.issues.values():
                if row["fingerprint"] == args[1]:
                    return dict(row)
            return None
        if "SELECT COUNT(*) AS n FROM agent_stumbles" in q:
            fp = args[1] if len(args) > 1 else ""
            if self.recent_stumbles_any is not None:
                return {"n": self.recent_stumbles_any}
            return {"n": self.recent_stumbles.get(fp, 0)}
        if "INSERT INTO agent_stumbles" in q:
            sid = str(uuid.uuid4())
            self.stumbles.append(
                {
                    "id": sid,
                    "org_id": args[1],
                    "trace_id": args[2],
                    "kind": args[7],
                    "fingerprint": args[8],
                    "title": args[9],
                    "detail": args[10],
                    "severity": args[11],
                    "detected_by": args[12],
                    "detected_at": datetime.now(UTC),
                }
            )
            return {"id": sid, "inserted": True}
        if "INSERT INTO issue_verifications" in q:
            verify_id, org_id, issue_id, fp, ref = (
                str(args[0]), args[1], str(args[2]), args[3], args[4],
            )
            existing = self.verifications.get(issue_id)
            if existing and existing["status"] == "pending":
                existing.update({"fingerprint": fp, "ref": ref, "attempts": 0})
                return {"id": existing["id"]}
            self.verifications[issue_id] = {
                "id": verify_id,
                "org_id": org_id,
                "issue_id": issue_id,
                "fingerprint": fp,
                "ref": ref,
                "status": "pending",
                "attempts": 0,
                "detail": {},
            }
            return {"id": verify_id}
        if "FROM improvement_plans WHERE org_id = $1 AND id = $2::uuid" in q:
            row = self.plans.get(str(args[1]))
            return dict(row) if row else None
        if "FROM improvement_plans" in q and "status = 'merged'" in q:
            merged = [
                p for p in self.plans.values()
                if p["status"] == "merged"
                and (
                    p.get("source_ref") == args[1]
                    or json.loads(p.get("evidence") or "{}").get("issue_id")
                    == args[2]
                )
            ]
            return dict(merged[-1]) if merged else None
        if "FROM improvement_plans" in q and "source_fingerprint" in q:
            for p in self.plans.values():
                if p.get("source_fingerprint") == args[1] and p["status"] in (
                    "draft", "pending_review", "approved", "pr_opened"
                ):
                    return dict(p)
            return None
        if "FROM autonomy_policies" in q:
            return dict(self.policy_row) if self.policy_row else None
        if "SELECT COUNT(*) AS n FROM self_heal_actions" in q:
            n = sum(
                1
                for h in self.heal_actions.values()
                if h["action_type"] == "rollback" and h["status"] == "executed"
            )
            return {"n": n}
        if "FROM self_heal_actions WHERE org_id = $1 AND id = $2" in q:
            row = self.heal_actions.get(str(args[1]))
            return dict(row) if row else None
        if "SELECT status FROM prompt_canaries" in q:
            row = self.canaries.get(str(args[1]))
            return {"status": row["status"]} if row else None
        if "FROM prompt_canaries" in q and "status = 'active'" in q:
            active = [c for c in self.canaries.values() if c["status"] == "active"]
            return dict(active[0]) if active else None
        if "FROM feature_kill_switches" in q:
            return None
        if "FROM repo_connections" in q:
            return dict(self.repo_connection) if self.repo_connection else None
        return None

    async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
        q = " ".join(query.split())
        if "issue_verifications" in q and "FOR UPDATE SKIP LOCKED" in q:
            return [
                {
                    "id": v["id"],
                    "org_id": v["org_id"],
                    "issue_id": v["issue_id"],
                    "fingerprint": v["fingerprint"],
                    "ref": v["ref"],
                    "attempts": v["attempts"],
                }
                for v in self.verifications.values()
                if v["status"] == "pending"
            ]
        if "FROM agent_stumbles" in q:
            rows = list(self.stumbles)
            if "fingerprint = $" in q and len(args) > 1:
                rows = [r for r in rows if r["fingerprint"] == args[1]]
            return [dict(r) for r in rows]
        if "FROM customer_cost_events" in q:
            return [{"cost_usd": 0}]
        return []

    async def fetchval(self, query: str, *args: Any) -> Any:
        q = " ".join(query.split())
        if "SELECT 1 FROM improvement_plans" in q and "parent_plan_id" in q:
            for p in self.plans.values():
                if str(p.get("parent_plan_id") or "") == str(args[1]) and p[
                    "status"
                ] in ("draft", "pending_review", "approved", "pr_opened"):
                    return 1
            return None
        return None

    async def execute(self, query: str, *args: Any) -> str:
        q = " ".join(query.split())
        if "UPDATE agent_issues" in q and "SET status = $3" in q:
            issue = self.issues.get(str(args[1]))
            if issue is None:
                return "UPDATE 0"
            issue["status"] = args[2]
            return "UPDATE 1"
        if "UPDATE agent_issues" in q and "SET triage_result" in q:
            issue = self.issues.get(str(args[1]))
            if issue is None:
                return "UPDATE 0"
            issue["triage_result"] = (
                json.loads(args[2]) if isinstance(args[2], str) else args[2]
            )
            return "UPDATE 1"
        if "INSERT INTO improvement_plans" in q:
            keys = (
                "id", "org_id", "run_id", "agent_id", "plan_kind", "status",
                "title", "summary", "source_ref", "source_fingerprint",
                "diff_unified", "files_changed", "evidence", "triage_snapshot",
                "estimated_blast_radius", "llm_cost_usd", "parent_plan_id",
            )
            row = dict(zip(keys, args, strict=True))
            row["id"] = str(row["id"])
            self.plans[row["id"]] = row
            return "INSERT 0 1"
        if "UPDATE improvement_plans" in q and "'pr_opened'" in q:
            plan = self.plans.get(str(args[1]))
            if plan is None:
                return "UPDATE 0"
            plan.update(
                {
                    "status": "pr_opened",
                    "pr_url": args[2],
                    "pr_number": args[3],
                    "github_branch": args[4],
                    "approved_by": args[5],
                }
            )
            return "UPDATE 1"
        if "UPDATE improvement_plans" in q and "'merged'" in q:
            plan = self.plans.get(str(args[1]))
            if plan is None or plan["status"] not in (args[2] or []):
                return "UPDATE 0"
            plan["status"] = "merged"
            return "UPDATE 1"
        if "UPDATE issue_verifications" in q and "completed_at = NOW()" in q:
            for v in self.verifications.values():
                if v["id"] == str(args[0]):
                    v.update(
                        {
                            "status": args[1],
                            "detail": json.loads(args[2]),
                            "attempts": int(args[3]),
                        }
                    )
                    return "UPDATE 1"
            return "UPDATE 0"
        if "UPDATE issue_verifications" in q and "SET attempts = $2" in q:
            for v in self.verifications.values():
                if v["id"] == str(args[0]):
                    v["attempts"] = int(args[1])
                    return "UPDATE 1"
            return "UPDATE 0"
        if "INSERT INTO issue_state_transitions" in q:
            self.transitions.append(
                {
                    "issue_id": str(args[2]),
                    "from_status": args[3],
                    "to_status": args[4],
                    "event_type": args[5],
                    "reason": args[6],
                    "actor": args[7],
                }
            )
            return "INSERT 0 1"
        if "INSERT INTO autonomy_audit_log" in q:
            self.audits.append(
                {
                    "org_id": args[1],
                    "agent_id": args[2],
                    "action": args[3],
                    "tier": args[4],
                    "decision": args[5],
                    "reason": args[6],
                }
            )
            return "INSERT 0 1"
        if "INSERT INTO self_heal_actions" in q:
            action_id = str(args[0])
            existing = self.heal_actions.get(action_id)
            if existing is not None:
                # ON CONFLICT (id) DO UPDATE SET status, after_state_json
                existing["status"] = args[3]
                existing["after_state_json"] = args[5]
            else:
                self.heal_actions[action_id] = {
                    "id": action_id,
                    "org_id": args[1],
                    "action_type": args[2],
                    "status": args[3],
                    "before_state_json": args[4],
                    "after_state_json": args[5],
                }
            return "INSERT 0 1"
        if "UPDATE prompt_canaries" in q and "'rolled_back'" in q:
            canary = self.canaries.get(str(args[1]))
            if canary is None:
                return "UPDATE 0"
            canary["status"] = "rolled_back"
            return "UPDATE 1"
        return "OK"


@pytest.fixture
def loop_db(mock_postgres_client) -> FakeLoopDB:
    """Install the stateful fake behind the suite-wide MagicMock client."""
    db = FakeLoopDB()
    mock_postgres_client.fetchrow = AsyncMock(side_effect=db.fetchrow)
    mock_postgres_client.fetch = AsyncMock(side_effect=db.fetch)
    mock_postgres_client.fetchval = AsyncMock(side_effect=db.fetchval)
    mock_postgres_client.execute = AsyncMock(side_effect=db.execute)
    return db


@pytest.fixture
def bus(monkeypatch: pytest.MonkeyPatch) -> list:
    """Capture every published LoopEvent (no Redis in tests).

    Patches both the orchestrator's module-level import and the
    event_bus module attribute (verify._emit imports lazily).
    """
    events: list = []

    async def _capture(event, redis=None):  # noqa: ARG001
        events.append(event)
        return True

    monkeypatch.setattr("eden.closed_loop.orchestrator.publish", _capture)
    monkeypatch.setattr("eden.closed_loop.event_bus.publish", _capture)
    return events


@pytest.fixture(autouse=True)
def _reset_verify_cooldown():
    """Clear the process-global verify empty-poll cooldown between tests."""
    from eden.closed_loop.verify import _reset_state_for_tests

    _reset_state_for_tests()
    yield
    _reset_state_for_tests()


# NOTE: the ``create_plan_shim`` fixture that bridged D28 (duplicate
# org_id in the propose persist payload) was removed in M3 — the strip
# behavior it provided is now the real behavior of
# ``_plan_payload_from_patch`` + ``plans_repo.create_plan``.
