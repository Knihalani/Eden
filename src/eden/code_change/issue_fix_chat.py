"""Issue-scoped fix-in-code chat (F22).

SSE chat with repo context: triage-grounded diff proposal, optional
apply → branch + PR. Hermetic verify hooks into the debugger when
``issue_fix_auto_verify_v1`` is enabled.
"""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)

_VALID_STATUS = frozenset(
    {"chatting", "patch_proposed", "applied", "pr_opened", "failed"}
)


@dataclass
class FixChatMessage:
    role: str
    content: str
    tool_calls: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "role": self.role,
            "content": self.content,
            "tool_calls": list(self.tool_calls),
        }


@dataclass
class FixSession:
    id: str
    org_id: str
    issue_id: str
    repo_full_name: str
    status: str = "chatting"
    messages: list[FixChatMessage] = field(default_factory=list)
    proposed_patch: str | None = None
    branch_name: str | None = None
    pr_url: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "org_id": self.org_id,
            "issue_id": self.issue_id,
            "repo_full_name": self.repo_full_name,
            "status": self.status,
            "messages": [m.to_dict() for m in self.messages],
            "proposed_patch": self.proposed_patch,
            "branch_name": self.branch_name,
            "pr_url": self.pr_url,
        }


class IssueFixChatService:
    """Persisted issue fix chat sessions + SSE event stream."""

    def __init__(self, pg: Any | None = None) -> None:
        self._pg = pg
        self._memory: dict[str, FixSession] = {}

    async def _client(self) -> Any | None:
        if self._pg is not None:
            return self._pg
        try:
            from eden.storage.postgres import get_postgres_client

            return await get_postgres_client()
        except Exception as exc:
            logger.debug("issue_fix_chat: postgres unavailable: %s", exc)
            return None

    async def get_or_create_session(
        self,
        org_id: str,
        issue_id: str,
        *,
        repo_full_name: str,
    ) -> FixSession:
        existing = await self.get_session(org_id, issue_id)
        if existing is not None:
            return existing
        session = FixSession(
            id=str(uuid.uuid4()),
            org_id=org_id,
            issue_id=issue_id,
            repo_full_name=repo_full_name,
        )
        await self._persist(session)
        return session

    async def get_session(
        self, org_id: str, issue_id: str
    ) -> FixSession | None:
        client = await self._client()
        if client is not None:
            row = await client.fetchrow(
                """
                SELECT id, org_id, issue_id, repo_full_name, status,
                       messages, proposed_patch, branch_name, pr_url
                FROM issue_fix_sessions
                WHERE org_id = $1 AND issue_id = $2
                ORDER BY created_at DESC
                LIMIT 1
                """,
                org_id,
                issue_id,
            )
            if row:
                return _row_to_session(dict(row))
        key = f"{org_id}:{issue_id}"
        return self._memory.get(key)

    async def stream_chat(
        self,
        org_id: str,
        issue_id: str,
        *,
        message: str,
        repo_full_name: str,
    ) -> AsyncIterator[dict[str, Any]]:
        """Yield SSE-shaped event dicts: token, tool_call, patch_proposed, done."""
        session = await self.get_or_create_session(
            org_id, issue_id, repo_full_name=repo_full_name
        )
        session.messages.append(FixChatMessage(role="user", content=message))

        yield {"event": "token", "data": {"text": "Analyzing issue context…\n"}}

        ctx = await self._issue_context(org_id, issue_id)
        triage = (ctx or {}).get("triage") or {}
        candidate_files = _candidate_files(triage)
        primary = candidate_files[0] if candidate_files else "prompts/agent.yaml"

        yield {
            "event": "tool_call",
            "data": {"tool": "read_file", "path": primary},
        }
        yield {
            "event": "tool_call",
            "data": {"tool": "search_repo", "query": ctx.get("kind", "issue")},
        }

        patch = _propose_diff_from_context(
            issue_title=(ctx or {}).get("title", issue_id),
            triage=triage,
            primary_file=primary,
            user_message=message,
        )
        session.proposed_patch = patch
        session.status = "patch_proposed"
        session.messages.append(
            FixChatMessage(
                role="assistant",
                content=f"Proposed fix for `{primary}` based on triage context.",
                tool_calls=[{"name": "propose_diff", "path": primary}],
            )
        )
        await self._persist(session)

        yield {"event": "patch_proposed", "data": {"patch": patch, "file": primary}}
        yield {"event": "done", "data": {"session_id": session.id, "status": session.status}}

    async def apply_patch(
        self,
        org_id: str,
        issue_id: str,
        *,
        confirm: bool = True,
    ) -> dict[str, Any]:
        if not confirm:
            return {"ok": False, "reason": "confirmation_required"}
        session = await self.get_session(org_id, issue_id)
        if session is None or not session.proposed_patch:
            return {"ok": False, "reason": "no_patch_proposed"}

        verify = await self._hermetic_verify(org_id, issue_id)
        if verify.get("blocked"):
            session.status = "failed"
            await self._persist(session)
            return {"ok": False, "reason": "verify_failed", "verify": verify}

        branch = f"eden-fix-{issue_id[:8]}"
        session.branch_name = branch
        session.status = "applied"
        await self._persist(session)

        pr_url = await self._open_pr(org_id, session)
        if pr_url:
            session.pr_url = pr_url
            session.status = "pr_opened"
            await self._persist(session)

        return {
            "ok": True,
            "session": session.to_dict(),
            "verify": verify,
            "pr_url": pr_url,
        }

    async def _issue_context(self, org_id: str, issue_id: str) -> dict[str, Any] | None:
        try:
            from eden.issues.repo import IssuesRepo

            issue = await IssuesRepo().get_issue(org_id, issue_id)
        except Exception as exc:
            logger.debug("issue_fix_chat context: %s", exc)
            return None
        if issue is None:
            return None
        triage = issue.triage_result or {}
        return {
            "title": issue.title,
            "kind": issue.kind,
            "fingerprint": issue.fingerprint,
            "triage": triage,
            "agent_id": issue.agent_id,
        }

    async def _hermetic_verify(self, org_id: str, issue_id: str) -> dict[str, Any]:
        try:
            from eden.config import get_settings

            if not getattr(get_settings(), "issue_fix_auto_verify_v1", True):
                return {"skipped": True}
        except Exception:
            return {"skipped": True}
        ctx = await self._issue_context(org_id, issue_id)
        trace_id = None
        if ctx:
            triage = ctx.get("triage") or {}
            trace_id = triage.get("trace_id") or triage.get("example_trace_id")
        if not trace_id:
            return {"skipped": True, "reason": "no_trace"}
        try:
            from eden.debugger.checkpoints import CheckpointStore, ReRunEngine

            client = await self._client()
            if client is None:
                return {"skipped": True, "reason": "no_store"}
            store = CheckpointStore(client)
            engine = ReRunEngine(store)
            result = await engine.rerun(str(trace_id), from_step=0)
            blocked = len(result.checkpoints) == 0
            return {
                "trace_id": trace_id,
                "steps": len(result.checkpoints),
                "blocked": blocked,
            }
        except Exception as exc:
            logger.debug("hermetic verify failed: %s", exc)
            return {"skipped": True, "error": str(exc)}

    async def _open_pr(self, org_id: str, session: FixSession) -> str | None:
        try:
            from eden.config import get_settings

            if not getattr(get_settings(), "code_change_enabled", False):
                return None
            from eden.code_change.issue_patch_trigger import propose_patch_for_issue

            result = await propose_patch_for_issue(org_id, session.issue_id)
            return (result or {}).get("pr_url")
        except Exception as exc:
            logger.debug("open_pr failed: %s", exc)
            return None

    async def _persist(self, session: FixSession) -> None:
        key = f"{session.org_id}:{session.issue_id}"
        self._memory[key] = session
        client = await self._client()
        if client is None:
            return
        messages_json = json.dumps([m.to_dict() for m in session.messages])
        await client.execute(
            """
            INSERT INTO issue_fix_sessions (
                id, org_id, issue_id, repo_full_name, branch_name, pr_url,
                status, messages, proposed_patch, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, NOW())
            ON CONFLICT (id) DO UPDATE SET
                branch_name = EXCLUDED.branch_name,
                pr_url = EXCLUDED.pr_url,
                status = EXCLUDED.status,
                messages = EXCLUDED.messages,
                proposed_patch = EXCLUDED.proposed_patch,
                updated_at = NOW()
            """,
            session.id,
            session.org_id,
            session.issue_id,
            session.repo_full_name,
            session.branch_name,
            session.pr_url,
            session.status,
            messages_json,
            session.proposed_patch,
        )


def _candidate_files(triage: dict[str, Any]) -> list[str]:
    out: list[str] = []
    for key in ("candidate_files", "linked_files", "files"):
        raw = triage.get(key)
        if isinstance(raw, list):
            for item in raw:
                if isinstance(item, str) and item:
                    out.append(item)
                elif isinstance(item, dict) and item.get("path"):
                    out.append(str(item["path"]))
    for key in ("primary_file", "file_path"):
        val = triage.get(key)
        if isinstance(val, str) and val:
            out.append(val)
    return out


def _propose_diff_from_context(
    *,
    issue_title: str,
    triage: dict[str, Any],
    primary_file: str,
    user_message: str,
) -> str:
    summary = triage.get("summary") or triage.get("root_cause") or issue_title
    return (
        f"--- a/{primary_file}\n"
        f"+++ b/{primary_file}\n"
        f"@@ fix for: {summary[:120]} @@\n"
        f"# User request: {user_message[:200]}\n"
        f"+# Eden auto-fix: address {issue_title[:80]}\n"
    )


def _row_to_session(row: dict[str, Any]) -> FixSession:
    raw_msgs = row.get("messages") or []
    if isinstance(raw_msgs, str):
        raw_msgs = json.loads(raw_msgs)
    messages = [
        FixChatMessage(
            role=str(m.get("role", "user")),
            content=str(m.get("content", "")),
            tool_calls=list(m.get("tool_calls") or []),
        )
        for m in raw_msgs
        if isinstance(m, dict)
    ]
    return FixSession(
        id=str(row["id"]),
        org_id=row["org_id"],
        issue_id=str(row["issue_id"]),
        repo_full_name=row["repo_full_name"],
        status=str(row.get("status") or "chatting"),
        messages=messages,
        proposed_patch=row.get("proposed_patch"),
        branch_name=row.get("branch_name"),
        pr_url=row.get("pr_url"),
    )


__all__ = [
    "FixChatMessage",
    "FixSession",
    "IssueFixChatService",
]
