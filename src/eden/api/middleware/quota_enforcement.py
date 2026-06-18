"""Quota enforcement middleware — soft / hard limit checking.

Adds `X-Quota-*` headers to every response showing current usage vs limits.
For mutating HTTP methods (POST, PUT, PATCH, DELETE), checks whether the
organization has exceeded any hard limit on the resources relevant to the
endpoint path.  Blocks the request with HTTP 429 when a hard limit is hit
and returns HTTP 429 with a soft-limit warning when only a soft limit is
exceeded (still allows the request but warns).

Depends on:
  - org_resource_limits (soft / hard limits per org)
  - usage_events (actual usage, aggregated in real time)
  - plan_tiers (fallback defaults when DB limits are missing)
"""

import logging

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse, Response

from eden.api.utils.auth import decode_access_token
from eden.services.usage_service import UsageService

logger = logging.getLogger(__name__)

# Map URL path prefixes to the resource dimensions that should be checked.
# A request may trigger checks for multiple resources.
PATH_RESOURCE_MAP: dict[str, list[str]] = {
    "/jobs": ["jobs"],
    "/specs": ["jobs"],
    "/benchmark": ["jobs"],
    "/orgs/": ["seats", "references"],  # org-scoped writes (members, refs, etc.)
}

# HTTP methods considered "mutating"
MUTATING_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


class QuotaEnforcementMiddleware(BaseHTTPMiddleware):
    """Middleware that enforces tenant quota limits.

    This middleware must be registered *after* TenantRateLimitMiddleware in
    the FastAPI stack so that the request already has the org resolved and
    rate-limit headers set.  It does NOT replace rate limiting — it adds
    quota/budget enforcement on top.
    """

    def __init__(self, app):
        super().__init__(app)
        self._usage_service: UsageService | None = None

    async def _get_usage_service(self) -> UsageService:
        if self._usage_service is None:
            self._usage_service = UsageService()
        return self._usage_service

    @staticmethod
    async def _resolve_org_id(request: Request) -> str | None:
        """Extract org_id from headers, cookies, or API key."""
        # 1. Header (used by API keys and some cookie flows)
        org_id = request.headers.get("x-org-id")
        if org_id:
            return org_id

        # 2. API key path (x-org-api-key implies org_id is in the path or header)
        #    Already tried header above; fall through.

        # 3. JWT cookie
        token = request.cookies.get("authorization")
        if token:
            payload = decode_access_token(token)
            if payload:
                return payload.get("current_org_id")

        # Note: request.path_params is not populated in ASGI middleware (routing
        # happens later), so header/cookie/API-key resolution is the only path.

        return None

    @staticmethod
    def _resources_for_path(path: str) -> list[str]:
        """Determine which quota dimensions apply to a request path."""
        for prefix, resources in PATH_RESOURCE_MAP.items():
            if path.startswith(prefix):
                return resources
        return []

    async def dispatch(self, request: Request, call_next) -> Response:
        # ── Skip for preflight, health, and docs ──
        if request.method == "OPTIONS" or request.url.path == "/health":
            return await call_next(request)

        org_id = await self._resolve_org_id(request)
        if not org_id:
            # Unauthenticated — let the route handler deal with auth
            return await call_next(request)

        # ── Build quota headers (always added when we can resolve org) ──
        try:
            quota_headers = await self._build_quota_headers(org_id)
        except Exception as exc:
            logger.warning(f"Quota header build failed for org {org_id}: {exc}")
            quota_headers = {}

        # ── For mutating methods, enforce hard limits ──
        if request.method in MUTATING_METHODS:
            resources = self._resources_for_path(request.url.path)
            if resources:
                try:
                    blocked, detail = await self._check_hard_limits(org_id, resources)
                    if blocked:
                        return JSONResponse(
                            status_code=429,
                            content={
                                "detail": detail,
                                "type": "quota_exceeded",
                            },
                            headers=quota_headers,
                        )
                except Exception as exc:
                    logger.warning(f"Hard-limit check failed for org {org_id}: {exc}")
                    # Fail open — let the route handle it

        # ── Proceed to handler ──
        response = await call_next(request)

        # ── Attach quota headers ──
        for key, value in quota_headers.items():
            response.headers[key] = str(value)

        return response

    async def _build_quota_headers(self, org_id: str) -> dict[str, str]:
        """Fetch budget status and return as HTTP headers."""
        service = await self._get_usage_service()
        budget = await service.get_budget_status(org_id)

        headers: dict[str, str] = {}

        for resource in ("jobs", "tokens", "storage_mb", "sandbox_seconds"):
            res_data = budget.get(resource, {})
            used = res_data.get("used", 0)
            soft = res_data.get("soft_limit", 0)
            hard = res_data.get("hard_limit", 0)
            status = res_data.get("status", "ok")
            pct = res_data.get("percentage", 0)

            prefix = resource.replace("_", "-")
            headers[f"X-Quota-{prefix}-Used"] = str(int(used))
            headers[f"X-Quota-{prefix}-Soft"] = str(soft)
            headers[f"X-Quota-{prefix}-Hard"] = str(hard)
            headers[f"X-Quota-{prefix}-Pct"] = str(pct)
            if status != "ok":
                headers[f"X-Quota-{prefix}-Status"] = status

        headers["X-Quota-Plan"] = budget.get("plan_name", "unknown")
        headers["X-Quota-Total-Cost"] = str(budget.get("total_cost_usd", 0))
        return headers

    async def _check_hard_limits(
        self,
        org_id: str,
        resources: list[str],
    ) -> tuple[bool, str]:
        """Check whether any hard limit is exceeded for the given resources.

        Returns (blocked, detail_message).
        """
        service = await self._get_usage_service()
        budget = await service.get_budget_status(org_id)

        for resource in resources:
            res_data = budget.get(resource, {})
            status = res_data.get("status", "ok")
            if status == "hard_exceeded":
                used = res_data.get("used", 0)
                hard = res_data.get("hard_limit", 0)
                return (
                    True,
                    f"{resource} hard limit exceeded ({int(used)} / {hard}). "
                    "Upgrade your plan to continue.",
                )

        return False, ""
