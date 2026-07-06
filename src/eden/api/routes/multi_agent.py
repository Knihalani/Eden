"""Multi-Agent Environment API routes (Phase 6.8).

Endpoints for communication, roles, memory tiers, planning frameworks,
and test suite execution.

Ref: eden-multi-agent-orchestration-architecture.md §2–10
"""

from __future__ import annotations

import logging
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_feature_flag
from eden.multi_agent import (
    ActionType,
    AgentObjective,
    BlackboardEntry,
    BlackboardEnvironment,
    HITLManager,
    MemoryService,
    Message,
    MessagePassingEnvironment,
    MultiAgentTestSuite,
    Observation,
    PlanAndExecuteEnvironment,
    ReActEnvironment,
    ReflexionEnvironment,
    RoleConfig,
    RoleHierarchy,
    RoleSystem,
    TreeOfThoughtsEnvironment,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/multi-agent",
    tags=["multi-agent"],
    dependencies=[Depends(require_feature_flag("enable_eval_pipeline"))],
)


# ──────────────────────────────────────────────────────────────────────────
# In-memory demo stores (production → database)
# ──────────────────────────────────────────────────────────────────────────

_environments: dict[str, dict[str, Any]] = {}
_role_systems: dict[str, RoleSystem] = {}
_memory_services: dict[str, MemoryService] = {}
_hitl_managers: dict[str, HITLManager] = {}
_test_suites: dict[str, dict[str, Any]] = {}


def _check_org_access(user: dict, org_id: str) -> bool:
    return any(o["id"] == org_id for o in user.get("organizations", []))


# ──────────────────────────────────────────────────────────────────────────
# Pydantic schemas
# ──────────────────────────────────────────────────────────────────────────

class CreateEnvironmentRequest(BaseModel):
    name: str = Field(..., description="Environment name")
    communication_pattern: str = Field(default="message_passing", description="message_passing | shared_state | blackboard")
    agent_count: int = Field(default=2, ge=2, le=20)
    max_steps: int = Field(default=50, ge=1, le=500)


class SendMessageRequest(BaseModel):
    from_agent: str
    to_agent: str
    content: dict[str, Any]
    msg_type: str = Field(default="request")


class RoleConfigRequest(BaseModel):
    role_name: str
    description: str = ""
    hierarchy: str = "flat"
    objectives: list[dict[str, Any]] = Field(default_factory=list)
    tools: list[str] = Field(default_factory=list)
    communication_pattern: str = "message_passing"
    memory_type: str = "working"
    can_delegate: bool = False
    max_subordinates: int = 0
    allowed_action_types: list[str] = Field(default_factory=list)
    dangerous_action_types: list[str] = Field(default_factory=list)
    timeout_seconds: int = 300


class AssignRoleRequest(BaseModel):
    agent_id: str
    role_name: str
    team_id: str | None = None
    supervisor_id: str | None = None


class HITLRuleRequest(BaseModel):
    action_type: str
    rule: str = "always_approve"


class ResolveApprovalRequest(BaseModel):
    approve: bool


class CheckHITLActionRequest(BaseModel):
    agent_id: str
    action_type: str
    action_payload: dict[str, Any] = Field(default_factory=dict)


class ObservationRequest(BaseModel):
    agent_id: str
    content: str
    source: str = "environment"
    salience: float = 0.5
    step_number: int = 0
    tags: list[str] = Field(default_factory=list)


class RunEpisodeRequest(BaseModel):
    framework: str = Field(..., description="react | tree_of_thoughts | plan_and_execute | reflexion")
    agent_ids: list[str]
    max_steps: int = 50


class RunTestsRequest(BaseModel):
    agent_count: int = 3
    action_count: int = 10


class BlackboardWriteRequest(BaseModel):
    agent_id: str
    content: dict[str, Any]
    confidence: float = 0.5
    category: str = "observation"


class DelegateTaskRequest(BaseModel):
    manager_id: str
    worker_id: str
    task: dict[str, Any]


# ──────────────────────────────────────────────────────────────────────────
# Environment management
# ──────────────────────────────────────────────────────────────────────────

@router.post("/environments", status_code=status.HTTP_201_CREATED)
async def create_environment(
    org_id: str,
    req: CreateEnvironmentRequest,
    user: dict = Depends(get_current_user),
):
    if not _check_org_access(user, org_id):
        raise HTTPException(status_code=403, detail="Access denied")

    env_id = f"env_{org_id}_{int(time.time() * 1000)}"

    if req.communication_pattern == "blackboard":
        env = BlackboardEnvironment()
    else:
        env = MessagePassingEnvironment()

    _environments[env_id] = {
        "env_id": env_id,
        "name": req.name,
        "pattern": req.communication_pattern,
        "agent_count": req.agent_count,
        "max_steps": req.max_steps,
        "created_at": time.time(),
        "environment": env,
        "org_id": org_id,
    }
    _role_systems[env_id] = RoleSystem()
    _memory_services[env_id] = MemoryService()
    _hitl_managers[env_id] = HITLManager()

    return {
        "env_id": env_id,
        "name": req.name,
        "communication_pattern": req.communication_pattern,
        "agent_count": req.agent_count,
        "max_steps": req.max_steps,
        "created_at": _environments[env_id]["created_at"],
    }


@router.get("/environments")
async def list_environments(org_id: str, user: dict = Depends(get_current_user)):
    if not _check_org_access(user, org_id):
        raise HTTPException(status_code=403, detail="Access denied")

    envs = [
        {
            "env_id": e["env_id"],
            "name": e["name"],
            "pattern": e["pattern"],
            "agent_count": e["agent_count"],
            "max_steps": e["max_steps"],
            "created_at": e["created_at"],
        }
        for e in _environments.values()
        if e["org_id"] == org_id
    ]
    return {"environments": envs, "total": len(envs)}


@router.get("/environments/{env_id}")
async def get_environment(env_id: str, org_id: str, user: dict = Depends(get_current_user)):
    if not _check_org_access(user, org_id):
        raise HTTPException(status_code=403, detail="Access denied")

    env = _environments.get(env_id)
    if not env or env["org_id"] != org_id:
        raise HTTPException(status_code=404, detail="Environment not found")

    role_system = _role_systems.get(env_id)
    memory_service = _memory_services.get(env_id)
    hitl = _hitl_managers.get(env_id)

    return {
        "env_id": env["env_id"],
        "name": env["name"],
        "pattern": env["pattern"],
        "agent_count": env["agent_count"],
        "max_steps": env["max_steps"],
        "created_at": env["created_at"],
        "role_system": role_system.to_dict() if role_system else None,
        "memory_stats": memory_service.stats() if memory_service else None,
        "hitl_stats": hitl.stats() if hitl else None,
    }


@router.delete("/environments/{env_id}")
async def delete_environment(env_id: str, org_id: str, user: dict = Depends(get_current_user)):
    if not _check_org_access(user, org_id):
        raise HTTPException(status_code=403, detail="Access denied")

    env = _environments.get(env_id)
    if not env or env["org_id"] != org_id:
        raise HTTPException(status_code=404, detail="Environment not found")

    _environments.pop(env_id, None)
    _role_systems.pop(env_id, None)
    _memory_services.pop(env_id, None)
    _hitl_managers.pop(env_id, None)
    _test_suites.pop(env_id, None)

    return {"message": "Environment deleted", "env_id": env_id}


# ──────────────────────────────────────────────────────────────────────────
# Communication
# ──────────────────────────────────────────────────────────────────────────

@router.post("/environments/{env_id}/messages")
async def send_message(
    env_id: str,
    org_id: str,
    req: SendMessageRequest,
    user: dict = Depends(get_current_user),
):
    if not _check_org_access(user, org_id):
        raise HTTPException(status_code=403, detail="Access denied")

    env = _environments.get(env_id)
    if not env or env["org_id"] != org_id:
        raise HTTPException(status_code=404, detail="Environment not found")

    env_obj = env["environment"]
    msg_type = req.msg_type
    try:
        from eden.multi_agent.communication import MessageType
        msg_type_enum = MessageType(msg_type)
    except ValueError:
        msg_type_enum = None

    if hasattr(env_obj, "send_message"):
        msg = env_obj.send_message(req.from_agent, req.to_agent, req.content, msg_type=msg_type_enum)
        return {"message": msg.to_dict(), "delivered": True}

    if hasattr(env_obj, "message_bus"):
        msg = Message(
            from_agent=req.from_agent,
            to_agent=req.to_agent,
            type=msg_type_enum or MessageType.REQUEST,
            content=req.content,
        )
        env_obj.message_bus.publish(req.to_agent, msg)
        return {"message": msg.to_dict(), "delivered": True}

    raise HTTPException(status_code=400, detail="Environment does not support message sending")


@router.get("/environments/{env_id}/messages/{agent_id}")
async def get_messages(
    env_id: str,
    org_id: str,
    agent_id: str,
    since_id: str | None = None,
    limit: int = 100,
    user: dict = Depends(get_current_user),
):
    if not _check_org_access(user, org_id):
        raise HTTPException(status_code=403, detail="Access denied")

    env = _environments.get(env_id)
    if not env or env["org_id"] != org_id:
        raise HTTPException(status_code=404, detail="Environment not found")

    env_obj = env["environment"]
    if hasattr(env_obj, "message_bus"):
        msgs = env_obj.message_bus.get_messages(agent_id, since_id=since_id, max_messages=limit)
        return {"messages": [m.to_dict() for m in msgs], "agent_id": agent_id}

    raise HTTPException(status_code=400, detail="Environment does not support message retrieval")


@router.post("/environments/{env_id}/broadcast")
async def broadcast_message(
    env_id: str,
    org_id: str,
    req: SendMessageRequest,
    user: dict = Depends(get_current_user),
):
    if not _check_org_access(user, org_id):
        raise HTTPException(status_code=403, detail="Access denied")

    env = _environments.get(env_id)
    if not env or env["org_id"] != org_id:
        raise HTTPException(status_code=404, detail="Environment not found")

    env_obj = env["environment"]
    if hasattr(env_obj, "broadcast"):
        recipients = env_obj.broadcast(req.from_agent, req.content, exclude=[req.to_agent] if req.to_agent else None)
        return {"recipients": recipients, "content": req.content}

    raise HTTPException(status_code=400, detail="Environment does not support broadcasting")


@router.get("/environments/{env_id}/communication/stats")
async def get_communication_stats(env_id: str, org_id: str, user: dict = Depends(get_current_user)):
    if not _check_org_access(user, org_id):
        raise HTTPException(status_code=403, detail="Access denied")

    env = _environments.get(env_id)
    if not env or env["org_id"] != org_id:
        raise HTTPException(status_code=404, detail="Environment not found")

    env_obj = env["environment"]
    if hasattr(env_obj, "message_bus"):
        return {"stats": env_obj.message_bus.stats()}
    if hasattr(env_obj, "blackboard"):
        return {"stats": env_obj.blackboard.stats()}

    return {"stats": {}}


# ──────────────────────────────────────────────────────────────────────────
# Blackboard
# ──────────────────────────────────────────────────────────────────────────

@router.post("/environments/{env_id}/blackboard")
async def write_blackboard(
    env_id: str,
    org_id: str,
    req: BlackboardWriteRequest,
    user: dict = Depends(get_current_user),
):
    if not _check_org_access(user, org_id):
        raise HTTPException(status_code=403, detail="Access denied")

    env = _environments.get(env_id)
    if not env or env["org_id"] != org_id:
        raise HTTPException(status_code=404, detail="Environment not found")

    env_obj = env["environment"]
    if not hasattr(env_obj, "blackboard"):
        raise HTTPException(status_code=400, detail="Environment does not use blackboard pattern")

    entry = BlackboardEntry(
        agent_id=req.agent_id,
        content=req.content,
        confidence=req.confidence,
        category=req.category,
    )
    env_obj.blackboard.post(entry)
    return {"entry": entry.to_dict(), "posted": True}


@router.get("/environments/{env_id}/blackboard")
async def read_blackboard(
    env_id: str,
    org_id: str,
    agent_id: str | None = None,
    category: str | None = None,
    limit: int = 100,
    user: dict = Depends(get_current_user),
):
    if not _check_org_access(user, org_id):
        raise HTTPException(status_code=403, detail="Access denied")

    env = _environments.get(env_id)
    if not env or env["org_id"] != org_id:
        raise HTTPException(status_code=404, detail="Environment not found")

    env_obj = env["environment"]
    if not hasattr(env_obj, "blackboard"):
        raise HTTPException(status_code=400, detail="Environment does not use blackboard pattern")

    entries = env_obj.blackboard.get_entries(agent_id=agent_id, category=category, limit=limit)
    return {"entries": [e.to_dict() for e in entries], "total": len(entries)}


@router.get("/environments/{env_id}/blackboard/search")
async def search_blackboard(
    env_id: str,
    org_id: str,
    query: str,
    k: int = 5,
    user: dict = Depends(get_current_user),
):
    if not _check_org_access(user, org_id):
        raise HTTPException(status_code=403, detail="Access denied")

    env = _environments.get(env_id)
    if not env or env["org_id"] != org_id:
        raise HTTPException(status_code=404, detail="Environment not found")

    env_obj = env["environment"]
    if not hasattr(env_obj, "blackboard"):
        raise HTTPException(status_code=400, detail="Environment does not use blackboard pattern")

    entries = env_obj.blackboard.similarity_search(query, k=k)
    return {"entries": [e.to_dict() for e in entries], "query": query}


# ──────────────────────────────────────────────────────────────────────────
# Roles
# ──────────────────────────────────────────────────────────────────────────

@router.post("/environments/{env_id}/role-configs")
async def create_role_config(
    env_id: str,
    org_id: str,
    req: RoleConfigRequest,
    user: dict = Depends(get_current_user),
):
    if not _check_org_access(user, org_id):
        raise HTTPException(status_code=403, detail="Access denied")

    env = _environments.get(env_id)
    if not env or env["org_id"] != org_id:
        raise HTTPException(status_code=404, detail="Environment not found")

    role_system = _role_systems.get(env_id)
    if not role_system:
        raise HTTPException(status_code=404, detail="Role system not initialized")

    hierarchy = RoleHierarchy.FLAT
    try:
        hierarchy = RoleHierarchy(req.hierarchy)
    except ValueError:
        # Unknown hierarchy value from the client — fall back to FLAT and log
        # so the misconfiguration is visible in the server log.
        logger.warning(
            "Unknown role hierarchy '%s' requested; falling back to FLAT",
            req.hierarchy,
        )

    objectives = [
        AgentObjective(
            name=o.get("name", "unnamed"),
            description=o.get("description", ""),
            priority=o.get("priority", 1),
            success_criteria=o.get("success_criteria", []),
            deadline_steps=o.get("deadline_steps"),
        )
        for o in req.objectives
    ]

    config = RoleConfig(
        role_name=req.role_name,
        description=req.description,
        hierarchy=hierarchy,
        objectives=objectives,
        tools=req.tools,
        communication_pattern=req.communication_pattern,
        memory_type=req.memory_type,
        can_delegate=req.can_delegate,
        max_subordinates=req.max_subordinates,
        allowed_action_types=[ActionType(a) for a in req.allowed_action_types if a in {t.value for t in ActionType}],
        dangerous_action_types=[ActionType(a) for a in req.dangerous_action_types if a in {t.value for t in ActionType}],
        timeout_seconds=req.timeout_seconds,
    )
    role_system.register_role_config(config)
    return {"config": config.to_dict()}


@router.get("/environments/{env_id}/role-configs")
async def list_role_configs(env_id: str, org_id: str, user: dict = Depends(get_current_user)):
    if not _check_org_access(user, org_id):
        raise HTTPException(status_code=403, detail="Access denied")

    env = _environments.get(env_id)
    if not env or env["org_id"] != org_id:
        raise HTTPException(status_code=404, detail="Environment not found")

    role_system = _role_systems.get(env_id)
    if not role_system:
        return {"configs": [], "total": 0}

    configs = list(role_system._role_configs.values())
    return {"configs": [c.to_dict() for c in configs], "total": len(configs)}


@router.post("/environments/{env_id}/roles")
async def assign_role(
    env_id: str,
    org_id: str,
    req: AssignRoleRequest,
    user: dict = Depends(get_current_user),
):
    if not _check_org_access(user, org_id):
        raise HTTPException(status_code=403, detail="Access denied")

    env = _environments.get(env_id)
    if not env or env["org_id"] != org_id:
        raise HTTPException(status_code=404, detail="Environment not found")

    role_system = _role_systems.get(env_id)
    if not role_system:
        raise HTTPException(status_code=404, detail="Role system not initialized")

    role = role_system.create_role(req.agent_id, req.role_name, team_id=req.team_id, supervisor_id=req.supervisor_id)
    return {"role": role.to_dict()}


@router.get("/environments/{env_id}/roles")
async def list_roles(env_id: str, org_id: str, user: dict = Depends(get_current_user)):
    if not _check_org_access(user, org_id):
        raise HTTPException(status_code=403, detail="Access denied")

    env = _environments.get(env_id)
    if not env or env["org_id"] != org_id:
        raise HTTPException(status_code=404, detail="Environment not found")

    role_system = _role_systems.get(env_id)
    if not role_system:
        return {"roles": [], "total": 0}

    return {"roles": [r.to_dict() for r in role_system.list_roles()], "total": len(role_system.list_roles())}


@router.post("/environments/{env_id}/delegate")
async def delegate_task(
    env_id: str,
    org_id: str,
    req: DelegateTaskRequest,
    user: dict = Depends(get_current_user),
):
    if not _check_org_access(user, org_id):
        raise HTTPException(status_code=403, detail="Access denied")

    env = _environments.get(env_id)
    if not env or env["org_id"] != org_id:
        raise HTTPException(status_code=404, detail="Environment not found")

    role_system = _role_systems.get(env_id)
    if not role_system:
        raise HTTPException(status_code=404, detail="Role system not initialized")

    result = role_system.assign_task(req.manager_id, req.worker_id, req.task)
    return result


@router.get("/environments/{env_id}/teams/{team_id}")
async def get_team_members(env_id: str, org_id: str, team_id: str, user: dict = Depends(get_current_user)):
    if not _check_org_access(user, org_id):
        raise HTTPException(status_code=403, detail="Access denied")

    env = _environments.get(env_id)
    if not env or env["org_id"] != org_id:
        raise HTTPException(status_code=404, detail="Environment not found")

    role_system = _role_systems.get(env_id)
    if not role_system:
        raise HTTPException(status_code=404, detail="Role system not initialized")

    members = role_system.get_team_members(team_id)
    return {"team_id": team_id, "members": [m.to_dict() for m in members]}


# ──────────────────────────────────────────────────────────────────────────
# Human-in-the-Loop
# ──────────────────────────────────────────────────────────────────────────

@router.post("/environments/{env_id}/hitl/rules")
async def set_hitl_rule(
    env_id: str,
    org_id: str,
    req: HITLRuleRequest,
    user: dict = Depends(get_current_user),
):
    if not _check_org_access(user, org_id):
        raise HTTPException(status_code=403, detail="Access denied")

    env = _environments.get(env_id)
    if not env or env["org_id"] != org_id:
        raise HTTPException(status_code=404, detail="Environment not found")

    hitl = _hitl_managers.get(env_id)
    if not hitl:
        raise HTTPException(status_code=404, detail="HITL manager not initialized")

    try:
        action_type = ActionType(req.action_type)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid action type: {req.action_type}") from None

    hitl.rules[action_type] = req.rule
    return {"rule_set": True, "action_type": req.action_type, "rule": req.rule}


@router.get("/environments/{env_id}/hitl/rules")
async def get_hitl_rules(env_id: str, org_id: str, user: dict = Depends(get_current_user)):
    if not _check_org_access(user, org_id):
        raise HTTPException(status_code=403, detail="Access denied")

    env = _environments.get(env_id)
    if not env or env["org_id"] != org_id:
        raise HTTPException(status_code=404, detail="Environment not found")

    hitl = _hitl_managers.get(env_id)
    if not hitl:
        raise HTTPException(status_code=404, detail="HITL manager not initialized")

    return {"rules": {k.value: v for k, v in hitl.rules.items()}}


@router.post("/environments/{env_id}/hitl/check")
async def check_hitl_action(
    env_id: str,
    org_id: str,
    req: CheckHITLActionRequest,
    user: dict = Depends(get_current_user),
):
    if not _check_org_access(user, org_id):
        raise HTTPException(status_code=403, detail="Access denied")

    env = _environments.get(env_id)
    if not env or env["org_id"] != org_id:
        raise HTTPException(status_code=404, detail="Environment not found")

    hitl = _hitl_managers.get(env_id)
    if not hitl:
        raise HTTPException(status_code=404, detail="HITL manager not initialized")

    try:
        at = ActionType(req.action_type)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid action type: {req.action_type}") from None

    result = await hitl.check_action(req.agent_id, at, req.action_payload)
    return result


@router.get("/environments/{env_id}/hitl/pending")
async def get_pending_approvals(env_id: str, org_id: str, user: dict = Depends(get_current_user)):
    if not _check_org_access(user, org_id):
        raise HTTPException(status_code=403, detail="Access denied")

    env = _environments.get(env_id)
    if not env or env["org_id"] != org_id:
        raise HTTPException(status_code=404, detail="Environment not found")

    hitl = _hitl_managers.get(env_id)
    if not hitl:
        raise HTTPException(status_code=404, detail="HITL manager not initialized")

    return {"pending": hitl.get_pending_approvals(), "count": len(hitl.get_pending_approvals())}


@router.post("/environments/{env_id}/hitl/approvals/{approval_id}/resolve")
async def resolve_approval(
    env_id: str,
    org_id: str,
    approval_id: str,
    req: ResolveApprovalRequest,
    user: dict = Depends(get_current_user),
):
    if not _check_org_access(user, org_id):
        raise HTTPException(status_code=403, detail="Access denied")

    env = _environments.get(env_id)
    if not env or env["org_id"] != org_id:
        raise HTTPException(status_code=404, detail="Environment not found")

    hitl = _hitl_managers.get(env_id)
    if not hitl:
        raise HTTPException(status_code=404, detail="HITL manager not initialized")

    return hitl.resolve_approval(approval_id, req.approve)


# ──────────────────────────────────────────────────────────────────────────
# Memory tiers
# ──────────────────────────────────────────────────────────────────────────

@router.post("/environments/{env_id}/memory/observations")
async def add_observation(
    env_id: str,
    org_id: str,
    req: ObservationRequest,
    user: dict = Depends(get_current_user),
):
    if not _check_org_access(user, org_id):
        raise HTTPException(status_code=403, detail="Access denied")

    env = _environments.get(env_id)
    if not env or env["org_id"] != org_id:
        raise HTTPException(status_code=404, detail="Environment not found")

    memory_service = _memory_services.get(env_id)
    if not memory_service:
        raise HTTPException(status_code=404, detail="Memory service not initialized")

    wm = memory_service.get_working_memory(req.agent_id)
    obs = Observation(
        content=req.content,
        source=req.source,
        salience=req.salience,
        step_number=req.step_number,
        tags=req.tags,
    )
    wm.add_observation(obs)
    return {"observation": obs.to_dict(), "working_memory_size": len(wm.recent_observations)}


@router.get("/environments/{env_id}/memory/{agent_id}")
async def query_memory(
    env_id: str,
    org_id: str,
    agent_id: str,
    query: str = "",
    k: int = 5,
    user: dict = Depends(get_current_user),
):
    if not _check_org_access(user, org_id):
        raise HTTPException(status_code=403, detail="Access denied")

    env = _environments.get(env_id)
    if not env or env["org_id"] != org_id:
        raise HTTPException(status_code=404, detail="Environment not found")

    memory_service = _memory_services.get(env_id)
    if not memory_service:
        raise HTTPException(status_code=404, detail="Memory service not initialized")

    result = memory_service.query_all_memories(agent_id, query, k=k)
    return result


@router.post("/environments/{env_id}/memory/consolidate")
async def consolidate_memories(
    env_id: str,
    org_id: str,
    agent_id: str,
    salience_threshold: float = 0.8,
    user: dict = Depends(get_current_user),
):
    if not _check_org_access(user, org_id):
        raise HTTPException(status_code=403, detail="Access denied")

    env = _environments.get(env_id)
    if not env or env["org_id"] != org_id:
        raise HTTPException(status_code=404, detail="Environment not found")

    memory_service = _memory_services.get(env_id)
    if not memory_service:
        raise HTTPException(status_code=404, detail="Memory service not initialized")

    result = await memory_service.consolidate_memories(agent_id, salience_threshold)
    return result


@router.get("/environments/{env_id}/memory/stats")
async def get_memory_stats(env_id: str, org_id: str, user: dict = Depends(get_current_user)):
    if not _check_org_access(user, org_id):
        raise HTTPException(status_code=403, detail="Access denied")

    env = _environments.get(env_id)
    if not env or env["org_id"] != org_id:
        raise HTTPException(status_code=404, detail="Environment not found")

    memory_service = _memory_services.get(env_id)
    if not memory_service:
        raise HTTPException(status_code=404, detail="Memory service not initialized")

    return memory_service.stats()


@router.post("/environments/{env_id}/memory/facts")
async def learn_fact(
    env_id: str,
    org_id: str,
    subject: str,
    relation: str,
    obj: str,
    confidence: float = 1.0,
    source: str = "",
    user: dict = Depends(get_current_user),
):
    if not _check_org_access(user, org_id):
        raise HTTPException(status_code=403, detail="Access denied")

    env = _environments.get(env_id)
    if not env or env["org_id"] != org_id:
        raise HTTPException(status_code=404, detail="Environment not found")

    memory_service = _memory_services.get(env_id)
    if not memory_service:
        raise HTTPException(status_code=404, detail="Memory service not initialized")

    fact = memory_service.semantic_memory.learn_fact(subject, relation, obj, confidence, source)
    return {"fact": fact.to_dict()}


# ──────────────────────────────────────────────────────────────────────────
# Planning frameworks
# ──────────────────────────────────────────────────────────────────────────

@router.get("/frameworks")
async def list_frameworks(org_id: str, user: dict = Depends(get_current_user)):
    if not _check_org_access(user, org_id):
        raise HTTPException(status_code=403, detail="Access denied")

    return {
        "frameworks": [
            {
                "id": "react",
                "name": "ReAct",
                "description": "Reasoning + Acting loop with tool use. Agent alternates between thinking and acting until the task is complete.",
                "supports": ["tool_use", "observation", "multi_step"],
                "complexity": "medium",
            },
            {
                "id": "tree_of_thoughts",
                "name": "Tree-of-Thoughts",
                "description": "Explore multiple reasoning paths via tree search. Best for complex problems with many possible approaches.",
                "supports": ["search", "branching", "evaluation"],
                "complexity": "high",
            },
            {
                "id": "plan_and_execute",
                "name": "Plan-and-Execute",
                "description": "Generate a full plan upfront, then execute step-by-step. Best for tasks with clear intermediate milestones.",
                "supports": ["planning", "execution", "sequential"],
                "complexity": "medium",
            },
            {
                "id": "reflexion",
                "name": "Reflexion",
                "description": "Agent critiques and improves its own behavior over iterations. Best for learning from failures.",
                "supports": ["self_criticism", "iteration", "improvement"],
                "complexity": "high",
            },
        ]
    }


@router.post("/environments/{env_id}/episodes")
async def run_episode(
    env_id: str,
    org_id: str,
    req: RunEpisodeRequest,
    user: dict = Depends(get_current_user),
):
    if not _check_org_access(user, org_id):
        raise HTTPException(status_code=403, detail="Access denied")

    env = _environments.get(env_id)
    if not env or env["org_id"] != org_id:
        raise HTTPException(status_code=404, detail="Environment not found")

    # Create dummy agents dict for the framework
    agents = dict.fromkeys(req.agent_ids)

    framework: Any = None
    if req.framework == "react":
        framework = ReActEnvironment(max_steps=req.max_steps)
    elif req.framework == "tree_of_thoughts":
        framework = TreeOfThoughtsEnvironment(max_steps=req.max_steps)
    elif req.framework == "plan_and_execute":
        framework = PlanAndExecuteEnvironment(max_steps=req.max_steps)
    elif req.framework == "reflexion":
        framework = ReflexionEnvironment(max_steps=req.max_steps)
    else:
        raise HTTPException(status_code=400, detail=f"Unknown framework: {req.framework}")

    # Get env state from the environment object
    env_obj = env["environment"]
    env_state = getattr(env_obj, "state", env_obj)

    result = framework.run_episode(agents, env_state)
    return {"result": result.to_dict(), "framework": req.framework}


# ──────────────────────────────────────────────────────────────────────────
# Test suite
# ──────────────────────────────────────────────────────────────────────────

@router.post("/environments/{env_id}/tests/run")
async def run_tests(
    env_id: str,
    org_id: str,
    req: RunTestsRequest,
    user: dict = Depends(get_current_user),
):
    if not _check_org_access(user, org_id):
        raise HTTPException(status_code=403, detail="Access denied")

    env = _environments.get(env_id)
    if not env or env["org_id"] != org_id:
        raise HTTPException(status_code=404, detail="Environment not found")

    suite = MultiAgentTestSuite()
    results = suite.run_all(agent_count=req.agent_count, action_count=req.action_count)
    _test_suites[env_id] = results
    return results


@router.get("/environments/{env_id}/tests/results")
async def get_test_results(env_id: str, org_id: str, user: dict = Depends(get_current_user)):
    if not _check_org_access(user, org_id):
        raise HTTPException(status_code=403, detail="Access denied")

    results = _test_suites.get(env_id)
    if not results:
        raise HTTPException(status_code=404, detail="No test results found. Run tests first.")

    return results


@router.post("/environments/{env_id}/tests/benchmark")
async def run_benchmark(
    env_id: str,
    org_id: str,
    agent_counts: list[int] | None = None,
    message_counts: list[int] | None = None,
    user: dict = Depends(get_current_user),
):
    if not _check_org_access(user, org_id):
        raise HTTPException(status_code=403, detail="Access denied")

    env = _environments.get(env_id)
    if not env or env["org_id"] != org_id:
        raise HTTPException(status_code=404, detail="Environment not found")

    suite = MultiAgentTestSuite()
    return suite.benchmark_performance(
        agent_counts=agent_counts or [2, 5, 10],
        message_counts=message_counts or [10, 50, 100],
    )

