"""Intelligence Gap — Behavior domain router (User, Guardrails, Autonomous, Closed Loop, Agents, Tools).

W3-6: consolidates deferred-router loading for:
  * intelligence_user
  * intelligence_guardrails
  * intelligence_autonomous
  * intelligence_closed_loop
  * intelligence_agents
  * intelligence_tools
"""
from __future__ import annotations

from fastapi import APIRouter

from eden.api.routes.intelligence_user import router as _user_router
from eden.api.routes.intelligence_guardrails import router as _guardrails_router
from eden.api.routes.intelligence_autonomous import router as _autonomous_router
from eden.api.routes.intelligence_closed_loop import router as _closed_loop_router
from eden.api.routes.intelligence_agents import router as _agents_router
from eden.api.routes.intelligence_tools import router as _tools_router

# Combined domain router — one deferred import instead of many.
router = APIRouter()
router.include_router(_user_router)
router.include_router(_guardrails_router)
router.include_router(_autonomous_router)
router.include_router(_closed_loop_router)
router.include_router(_agents_router)
router.include_router(_tools_router)
