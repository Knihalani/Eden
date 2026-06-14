"""Eden Public API v1 — Environment routes.

Phase 2: the env-gen pipeline (Planner→Critic→Refiner→…→Archivist) has
been retired. The env-gen blob store (environment code, tests, versions)
no longer has new writes. These routes are stubbed to 410 Gone so any
remaining caller fails clearly rather than silently.

The replacement surface is the Eden Agent CLI's ``/eden-sim`` command
(``cli/eden/commands/sim.py``) for sim + test generation, and (when
shipped) the Phase 3 web upload + sim/test runner portal surface.
"""

import logging
from typing import Any

from fastapi import APIRouter, Request

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/v1/environments", tags=["v1-environments"])


_GONE_DETAIL = (
    "The Eden environment-generation pipeline was retired in Phase 2. "
    "Use the Eden Agent CLI's `/eden-sim` command to generate "
    "simulations + test cases for your agent, grounded in observability. "
    "A web upload + sim/test runner portal surface is planned for "
    "Phase 3."
)


async def _gone(_request: Request) -> dict[str, Any]:  # noqa: ANN001
    """Return 410 Gone for every environment route."""
    from fastapi import HTTPException

    raise HTTPException(status_code=410, detail=_GONE_DETAIL)


# Mount the same handler at every original path so callers that hit any
# of the previously-valid routes get a clear 410.
router.add_api_route("", _gone, methods=["GET"])
router.add_api_route("/{job_id}", _gone, methods=["GET"])
router.add_api_route("/{job_id}/download", _gone, methods=["GET"])
router.add_api_route("/{job_id}/tests", _gone, methods=["GET"])
router.add_api_route("/{job_id}/versions", _gone, methods=["GET"])
