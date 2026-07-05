"""Multi-agent role system and human-in-the-loop integration.

Ref: eden-multi-agent-orchestration-architecture.md §3, §3.2
"""

from __future__ import annotations

import time
from collections import defaultdict
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

# ──────────────────────────────────────────────────────────────────────────
# Enums
# ──────────────────────────────────────────────────────────────────────────

class ActionType(StrEnum):
    CODE_EXECUTION = "code_execution"
    FILE_WRITE = "file_write"
    NETWORK_ACCESS = "network_access"
    API_KEY_USAGE = "api_key_usage"
    SYSTEM_COMMAND = "system_command"
    MESSAGE_SEND = "message_send"
    STATE_UPDATE = "state_update"
    TOOL_CALL = "tool_call"


class ActionResult(StrEnum):
    APPROVED = "approved"
    BLOCKED = "blocked"
    PENDING = "pending"
    TIMEOUT = "timeout"


class RoleHierarchy(StrEnum):
    FLAT = "flat"               # Peer-to-peer
    MANAGER_WORKER = "manager_worker"
    SPECIALIST_POOL = "specialist_pool"
    ADVERSARIAL = "adversarial"


# ──────────────────────────────────────────────────────────────────────────
# Role configuration
# ──────────────────────────────────────────────────────────────────────────

@dataclass
class AgentObjective:
    """A single objective for an agent role."""

    name: str
    description: str
    priority: int = 1  # Higher = more important
    success_criteria: list[str] = field(default_factory=list)
    deadline_steps: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "priority": self.priority,
            "success_criteria": self.success_criteria,
            "deadline_steps": self.deadline_steps,
        }


@dataclass
class RoleConfig:
    """Static configuration for an agent role."""

    role_name: str
    description: str = ""
    hierarchy: RoleHierarchy = RoleHierarchy.FLAT
    objectives: list[AgentObjective] = field(default_factory=list)
    tools: list[str] = field(default_factory=list)
    communication_pattern: str = "message_passing"  # message_passing | shared_state | blackboard
    memory_type: str = "working"  # working | episodic | semantic
    can_delegate: bool = False
    max_subordinates: int = 0
    allowed_action_types: list[ActionType] = field(default_factory=list)
    dangerous_action_types: list[ActionType] = field(default_factory=list)
    timeout_seconds: int = 300

    def to_dict(self) -> dict[str, Any]:
        return {
            "role_name": self.role_name,
            "description": self.description,
            "hierarchy": self.hierarchy.value,
            "objectives": [o.to_dict() for o in self.objectives],
            "tools": self.tools,
            "communication_pattern": self.communication_pattern,
            "memory_type": self.memory_type,
            "can_delegate": self.can_delegate,
            "max_subordinates": self.max_subordinates,
            "allowed_action_types": [a.value for a in self.allowed_action_types],
            "dangerous_action_types": [a.value for a in self.dangerous_action_types],
            "timeout_seconds": self.timeout_seconds,
        }


@dataclass
class AgentRole:
    """An instantiated agent role within an environment."""

    agent_id: str
    config: RoleConfig
    team_id: str | None = None  # For adversarial: "red" or "blue"
    current_objective_index: int = 0
    completed_objectives: list[str] = field(default_factory=list)
    subordinate_ids: list[str] = field(default_factory=list)
    supervisor_id: str | None = None
    created_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {
            "agent_id": self.agent_id,
            "role_name": self.config.role_name,
            "team_id": self.team_id,
            "current_objective": self.current_objective.name if self.current_objective else None,
            "completed_objectives": self.completed_objectives,
            "subordinate_count": len(self.subordinate_ids),
            "supervisor_id": self.supervisor_id,
            "created_at": self.created_at,
        }

    @property
    def current_objective(self) -> AgentObjective | None:
        objectives = self.config.objectives
        if not objectives or self.current_objective_index >= len(objectives):
            return None
        return objectives[self.current_objective_index]

    def advance_objective(self) -> bool:
        """Mark current objective complete and advance. Returns False if no more objectives."""
        if self.current_objective:
            self.completed_objectives.append(self.current_objective.name)
        self.current_objective_index += 1
        return self.current_objective is not None

    def can_perform(self, action_type: ActionType) -> bool:
        if not self.config.allowed_action_types:
            return True  # Default allow if not restricted
        return action_type in self.config.allowed_action_types

    def is_dangerous(self, action_type: ActionType) -> bool:
        return action_type in self.config.dangerous_action_types


# ──────────────────────────────────────────────────────────────────────────
# RoleSystem
# ──────────────────────────────────────────────────────────────────────────

class RoleSystem:
    """Manages all agent roles within a multi-agent environment."""

    def __init__(self):
        self._roles: dict[str, AgentRole] = {}
        self._role_configs: dict[str, RoleConfig] = {}
        self._teams: dict[str, list[str]] = defaultdict(list)

    def register_role_config(self, config: RoleConfig) -> None:
        self._role_configs[config.role_name] = config

    def create_role(
        self,
        agent_id: str,
        role_name: str,
        team_id: str | None = None,
        supervisor_id: str | None = None,
    ) -> AgentRole:
        config = self._role_configs.get(role_name)
        if not config:
            raise ValueError(f"Unknown role name: {role_name}")

        role = AgentRole(
            agent_id=agent_id,
            config=config,
            team_id=team_id,
            supervisor_id=supervisor_id,
        )
        self._roles[agent_id] = role
        if team_id:
            self._teams[team_id].append(agent_id)
        if supervisor_id:
            supervisor = self._roles.get(supervisor_id)
            if supervisor:
                supervisor.subordinate_ids.append(agent_id)
        return role

    def get_role(self, agent_id: str) -> AgentRole | None:
        return self._roles.get(agent_id)

    def get_team_members(self, team_id: str) -> list[AgentRole]:
        return [self._roles[aid] for aid in self._teams.get(team_id, []) if aid in self._roles]

    def get_subordinates(self, agent_id: str) -> list[AgentRole]:
        role = self._roles.get(agent_id)
        if not role:
            return []
        return [self._roles[sid] for sid in role.subordinate_ids if sid in self._roles]

    def get_supervisor(self, agent_id: str) -> AgentRole | None:
        role = self._roles.get(agent_id)
        if not role or not role.supervisor_id:
            return None
        return self._roles.get(role.supervisor_id)

    def can_delegate_to(self, manager_id: str, worker_id: str) -> bool:
        manager = self._roles.get(manager_id)
        if not manager or not manager.config.can_delegate:
            return False
        if len(manager.subordinate_ids) >= manager.config.max_subordinates:
            return False
        worker = self._roles.get(worker_id)
        if not worker:
            return False
        return worker.supervisor_id == manager_id or worker.supervisor_id is None

    def assign_task(self, manager_id: str, worker_id: str, task: dict[str, Any]) -> dict[str, Any]:
        if not self.can_delegate_to(manager_id, worker_id):
            return {"assigned": False, "reason": "Cannot delegate to this agent"}
        manager = self._roles[manager_id]
        worker = self._roles[worker_id]
        if worker.supervisor_id is None:
            worker.supervisor_id = manager_id
            manager.subordinate_ids.append(worker_id)
        return {"assigned": True, "task": task, "worker_id": worker_id}

    def list_roles(self) -> list[AgentRole]:
        return list(self._roles.values())

    def to_dict(self) -> dict[str, Any]:
        return {
            "roles": [r.to_dict() for r in self._roles.values()],
            "teams": dict(self._teams.items()),
            "role_configs": {name: cfg.to_dict() for name, cfg in self._role_configs.items()},
        }


# ──────────────────────────────────────────────────────────────────────────
# Human-in-the-Loop Manager
# ──────────────────────────────────────────────────────────────────────────

class HITLManager:
    """Intercepts agent actions at configurable checkpoints."""

    DEFAULT_RULES: dict[ActionType, str] = {
        ActionType.CODE_EXECUTION: "always_approve",
        ActionType.FILE_WRITE: "approve_if_reviewed",
        ActionType.NETWORK_ACCESS: "require_human",
        ActionType.API_KEY_USAGE: "require_human",
        ActionType.SYSTEM_COMMAND: "block",
        ActionType.MESSAGE_SEND: "always_approve",
        ActionType.STATE_UPDATE: "always_approve",
        ActionType.TOOL_CALL: "always_approve",
    }

    def __init__(self, rules: dict[ActionType, str] | None = None):
        self.rules = rules or dict(self.DEFAULT_RULES)
        self._pending_approvals: dict[str, dict[str, Any]] = {}
        self._approval_resolutions: dict[str, str] = {}  # approval_id -> "approved" | "blocked"
        self._total_approvals = 0
        self._total_blocks = 0

    async def check_action(
        self,
        agent_id: str,
        action_type: ActionType,
        action_payload: dict[str, Any],
        reviewer: Any | None = None,
    ) -> dict[str, Any]:
        """Check if an action is approved. Returns resolution dict."""
        rule = self.rules.get(action_type, "require_human")

        if rule == "always_approve":
            return {"result": ActionResult.APPROVED.value, "reason": "Auto-approved"}

        if rule == "block":
            self._total_blocks += 1
            return {"result": ActionResult.BLOCKED.value, "reason": "This action type is not permitted"}

        if rule == "approve_if_reviewed":
            if reviewer and hasattr(reviewer, "has_approved"):
                approved = await reviewer.has_approved(agent_id, action_payload)
                if approved:
                    return {"result": ActionResult.APPROVED.value, "reason": "Reviewer pre-approved"}
            return {"result": ActionResult.BLOCKED.value, "reason": "Awaiting reviewer approval"}

        if rule == "require_human":
            approval_id = f"{agent_id}_{action_type.value}_{time.time()}"
            self._pending_approvals[approval_id] = {
                "agent_id": agent_id,
                "action_type": action_type.value,
                "payload": action_payload,
                "requested_at": time.time(),
            }
            return {
                "result": ActionResult.PENDING.value,
                "approval_id": approval_id,
                "reason": "Awaiting human approval",
            }

        return {"result": ActionResult.BLOCKED.value, "reason": f"Unknown rule: {rule}"}

    def resolve_approval(self, approval_id: str, approve: bool) -> dict[str, Any]:
        if approval_id not in self._pending_approvals:
            return {"resolved": False, "reason": "Approval request not found"}
        del self._pending_approvals[approval_id]
        self._approval_resolutions[approval_id] = "approved" if approve else "blocked"
        if approve:
            self._total_approvals += 1
        else:
            self._total_blocks += 1
        return {
            "resolved": True,
            "approved": approve,
            "approval_id": approval_id,
        }

    def get_pending_approvals(self) -> list[dict[str, Any]]:
        return [
            {"approval_id": k, **v}
            for k, v in self._pending_approvals.items()
        ]

    def stats(self) -> dict[str, Any]:
        return {
            "total_approvals": self._total_approvals,
            "total_blocks": self._total_blocks,
            "pending_count": len(self._pending_approvals),
            "rules": {k.value: v for k, v in self.rules.items()},
        }
