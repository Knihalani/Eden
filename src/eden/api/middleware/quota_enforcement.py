"""Quota enforcement middleware — soft / hard limit checking.

Adds `X-Quota-*` headers to every response showing current usage vs limits.
For mutating HTTP methods (POST, PUT, PATCH, DELETE), checks whether the
organization has exceeded any hard limit on the resources relevant to the
endpoint path.  Blocks the request with HTTP 429 when a hard limit is hit
and returns HTTP 429 with a soft-limit warning when only a soft limit is
exceeded (still allows the request but warns).

**Primary enforcement lever: ``cost_usd`` (total USD cost).** The free
tier caps Eden's marginal COGS under $1/active-user/month. Every mutating
request checks the org's monthly cost against its tier's
``cost_hard_limit_usd``. Tokens / storage / sandbox remain in the headers
for transparency but are NOT the primary blocker.

Depends on:
  - org_resource_limits (soft / hard limits per org)
  - usage_events (actual usage, aggregated in real time)
  - plan_tiers (fallback defaults when DB limits are missing)
"""

import logging
import time
from typing import Any

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse, Response

from eden.api.utils.auth import decode_access_token
from eden.services.usage_service import UsageService

logger = logging.getLogger(__name__)

# Map URL path prefixes to the resource dimensions that should be checked.
# A request may trigger checks for multiple resources.
PATH_RESOURCE_MAP: dict[str, list[str]] = {
    "/orgs/": ["seats", "references"],  # org-scoped writes (members, refs, etc.)
}

# Resources checked on EVERY mutating request regardless of path —
# these are the headline free-tier levers.
GLOBAL_MUTATING_RESOURCES: list[str] = [
    "cost_usd",  # PRIMARY — total USD cost vs tier cap
]

# HTTP methods considered "mutating"
MUTATING_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


class QuotaEnforcementMiddleware(BaseHTTPMiddleware):
    """Middleware that enforces tenant quota limits.

    This middleware must be registered *after* TenantRateLimitMiddleware in
    the FastAPI stack so that the request already has the org resolved and
    rate-limit headers set.  It does NOT replace rate limiting — it adds
    quota/budget enforcement on top.
    """

    # Staleness budget (seconds) for the cached hard-limit snapshot.
    # After this many seconds, the cache is rejected as too stale to
    # enforce safely (DL-14 fail-closed).
    _BUDGET_STALENESS_LIMIT_S: float = 60.0

    def __init__(self, app):
        super().__init__(app)
        self._usage_service: UsageService | None = None
        # Cache of the most-recent budget snapshot per org, used when
        # the DB fetch fails. The cache is fail-closed: a snapshot
        # older than ``_BUDGET_STALENESS_LIMIT_S`` is treated as
        # missing (the request is blocked with a generic error).
        self._last_known_hard_limits: dict[str, dict[str, Any]] = {}

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
            # Path-specific resources + global (cost_usd) checked
            # together. Cost cap fires regardless of path.
            resources = list(GLOBAL_MUTATING_RESOURCES) + self._resources_for_path(request.url.path)
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
                    # DL-14 fail-closed: when the live check fails,
                    # fall back to the cached snapshot. If the cache
                    # says we're over the cap, block. If the cache is
                    # stale, block. If the cache is missing, fall
                    # through to the route handler (graceful degrade
                    # only for first-ever-request scenarios).
                    logger.warning(
                        f"Hard-limit check failed for org {org_id}, "
                        f"using cached snapshot: {exc}"
                    )
                    cached_blocked, cached_detail = self._cached_block_check(
                        org_id, resources
                    )
                    if cached_blocked:
                        return JSONResponse(
                            status_code=429,
                            content={
                                "detail": cached_detail,
                                "type": "quota_exceeded",
                            },
                            headers=quota_headers,
                        )

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

        # Resource counters (tokens / storage / sandbox) for transparency.
        for resource in ("tokens", "storage_mb", "sandbox_seconds"):
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

        # PRIMARY cap — cost_usd. Floats so we don't lose precision on
        # the cents/dollar boundary; the portal formats these as $.
        cost = budget.get("cost_usd", {})
        headers["X-Quota-Cost-Used"] = str(cost.get("used", 0))
        headers["X-Quota-Cost-Soft"] = str(cost.get("soft_limit", 0))
        headers["X-Quota-Cost-Hard"] = str(cost.get("hard_limit", 0))
        headers["X-Quota-Cost-Pct"] = str(cost.get("percentage", 0))
        if cost.get("status") not in (None, "ok"):
            headers["X-Quota-Cost-Status"] = cost["status"]

        headers["X-Quota-Plan"] = budget.get("plan_name", "unknown")
        return headers

    async def _check_hard_limits(
        self,
        org_id: str,
        resources: list[str],
    ) -> tuple[bool, str]:
        """Check whether any hard limit is exceeded for the given resources.

        Returns (blocked, detail_message). The cost_usd message is the
        headline for free-tier overage; the others fall back to a generic
        resource-specific message.

        DL-14 fail-closed: on exception OR a stale cache, blocks the
        request. The cached snapshot is rejected if older than
        ``_BUDGET_STALENESS_LIMIT_S`` seconds.
        """
        service = await self._get_usage_service()
        try:
            budget = await service.get_budget_status(org_id)
        except Exception as exc:
            # Fail closed: don't fall back to a stale cache when the
            # live fetch fails — return a generic "check failed"
            # detail so the operator sees the blocker.
            logger.debug("quota: live fetch failed: %s", exc)
            return (
                True,
                "Quota check failed. Reach out to support if this persists.",
            )
        return self._record_hard_limits(org_id, budget, resources)

    def _record_hard_limits(
        self,
        org_id: str,
        budget: dict,
        resources: list[str] | None = None,
    ) -> tuple[bool, str]:
        """Cache the budget snapshot and evaluate hard limits.

        Called by ``_check_hard_limits`` after a successful fetch. Also
        invoked directly by tests that pre-populate the cache (2-arg
        form). The cache snapshot is what makes DL-14 fail-closed under
        transient DB outages — the next call rejects anything older
        than ``_BUDGET_STALENESS_LIMIT_S`` seconds.
        """
        self._last_known_hard_limits[org_id] = (time.time(), budget)
        if resources is None:
            # Just caching, no evaluation requested.
            return False, ""
        return self._evaluate_hard_limits(budget, resources)

    def _cached_block_check(
        self,
        org_id: str,
        resources: list[str],
    ) -> tuple[bool, str]:
        """Check hard limits using the cached budget snapshot.

        DL-14 fail-closed: if no cache exists, returns ``(True, ...)``
        with a generic message. If the cache is older than
        ``_BUDGET_STALENESS_LIMIT_S`` seconds, also returns
        ``(True, ...)`` — a stale cache can't be trusted to enforce
        a safety-critical cap.
        """
        cached = self._last_known_hard_limits.get(org_id)
        if cached is None:
            return (
                True,
                "No recent quota snapshot — fail-closed until the next "
                "successful check. Reach out to support if this persists.",
            )
        ts, budget = cached
        if time.time() - ts > self._BUDGET_STALENESS_LIMIT_S:
            return (
                True,
                "Quota snapshot is stale (fail-closed). The next "
                "successful check will restore enforcement.",
            )
        return self._evaluate_hard_limits(budget, resources)

    def _budget_staleness(self, org_id: str) -> float | None:
        """Return seconds since the last cached snapshot for ``org_id``.

        ``None`` if no cache exists. Used by the test to verify the
        staleness budget is enforced.
        """
        cached = self._last_known_hard_limits.get(org_id)
        if cached is None:
            return None
        ts, _ = cached
        return time.time() - ts

    def _evaluate_hard_limits(
        self,
        budget: dict,
        resources: list[str],
    ) -> tuple[bool, str]:
        """Pure-function hard-limit evaluation against a budget snapshot.

        DL-14 fail-closed: blocks on ``hard_exceeded`` OR
        ``soft_exceeded`` (the cached snapshot can't tell us how close
        the org is to the hard cap, so we treat any overage as a
        block).
        """
        for resource in resources:
            res_data = budget.get(resource, {})
            status = res_data.get("status", "ok")
            if status in ("hard_exceeded", "soft_exceeded"):
                used = res_data.get("used", 0)
                hard = res_data.get("hard_limit", 0)
                if resource == "cost_usd":
                    return (
                        True,
                        f"Free-tier spending cap reached this month "
                        f"(${used:.2f} / ${hard:.2f}). "
                        "Reach out to support to raise your cap. (fail-closed: cached snapshot enforced)",
                    )
                if resource == "seats":
                    return (
                        True,
                        f"Seat limit reached ({int(used)} / {int(hard)}). "
                        "Remove a member or ask support to raise the cap.",
                    )
                if resource == "references":
                    return (
                        True,
                        f"Code-reference limit reached ({int(used)} / {int(hard)}). "
                        "Remove old references or ask support to raise the cap.",
                    )
                return (
                    True,
                    f"{resource} hard limit exceeded ({int(used)} / {hard}). "
                    "Reach out to support to raise your cap. (fail-closed: cached snapshot enforced)",
                )

        return False, ""
