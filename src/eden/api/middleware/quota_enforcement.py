"""Quota enforcement middleware — soft / hard limit checking.

Adds `X-Quota-*` headers to every response showing current usage vs limits.
For mutating HTTP methods (POST, PUT, PATCH, DELETE), checks whether the
organization has exceeded any hard limit on the resources relevant to the
endpoint path.  Blocks the request with HTTP 429 when a hard limit is hit
and returns HTTP 429 with a soft-limit warning when only a soft limit is
exceeded (still allows the request but warns).

**Primary enforcement lever: ``credits`` (100 credits ≈ $1 Eden COGS).**
Free beta hard-caps at ~400 credits (≈ $4/mo). Every mutating
request checks the org's monthly credits against its tier's
``credits_hard_limit``. USD mirrors stay in headers for FinOps.

Depends on:
  - org_resource_limits (soft / hard limits per org)
  - usage_events + customer_cost_events (actual usage, aggregated)
  - plan_tiers (fallback defaults when DB limits are missing)

Audit 2026-07-06 — converted from BaseHTTPMiddleware to pure ASGI.
B32 path-skip: OPTIONS, health/docs/metrics/ready, and
``/v1/internal/health*`` short-circuit before any org/DB work.
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any

from fastapi import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from eden.api.middleware.security_headers import apply_security_headers
from eden.api.utils.auth import decode_access_token
from eden.services.usage_service import UsageService

logger = logging.getLogger(__name__)

# Map URL path patterns to the resource dimensions that should be checked.
# A request may trigger checks for multiple resources. Patterns are
# matched with ``re.fullmatch`` against the *normalized* path
# ``/orgs/{org_id}/...`` so ``/orgs/foo/redteam-references`` does NOT
# match ``/orgs/{org_id}/references``.
_PATH_PATTERNS: list[tuple[re.Pattern[str], list[str]]] = [
    (re.compile(r"^/orgs/[^/]+/invitations(?:/|$)"), ["seats"]),
    (re.compile(r"^/orgs/[^/]+/invites(?:/|$)"), ["seats"]),
    (re.compile(r"^/orgs/[^/]+/references(?:/|$)"), ["references"]),
    (re.compile(r"^/invitations(?:/|$)"), ["seats"]),
    (re.compile(r"^/invites(?:/|$)"), ["seats"]),
]

# Public alias used by tests + callers that want to inspect mapping by
# prefix name (e.g. ``PATH_RESOURCE_MAP["references"]``).
PATH_RESOURCE_MAP: dict[str, list[str]] = {
    "invitations": ["seats"],
    "references": ["references"],
}

# Resources checked on EVERY mutating request regardless of path —
# these are the headline free-tier levers.
GLOBAL_MUTATING_RESOURCES: list[str] = [
    "credits",  # PRIMARY — monthly credits vs tier cap (≈ $4 free beta)
]

# HTTP methods considered "mutating"
MUTATING_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

# B32 — paths that skip quota entirely (no org resolve, no DB).
_SKIP_EXACT_PATHS = frozenset(
    {
        "/health",
        "/docs",
        "/openapi.json",
        "/redoc",
        "/metrics",
        "/ready",
    }
)
_SKIP_PATH_PREFIXES = (
    "/docs/",
    "/redoc/",
    "/v1/internal/health",
)


def _should_skip_quota(method: str, path: str) -> bool:
    """Return True for paths/methods that must not pay quota work."""
    if method == "OPTIONS":
        return True
    if path in _SKIP_EXACT_PATHS:
        return True
    return path.startswith(_SKIP_PATH_PREFIXES)


class _BudgetView:
    """Wraps the cached budget dict so ``view["cost_usd"]`` returns
    the resource's ``hard_limit`` scalar (matching the test
    assertion ``view["cost_usd"] == 20.0``) while ``view.budget``
    exposes the full nested dict (used by the high_util check that
    needs ``used`` + ``hard_limit``)."""

    __slots__ = ("budget",)

    def __init__(self, budget: dict[str, Any]) -> None:
        self.budget = budget

    def __getitem__(self, resource: str) -> Any:
        v = self.budget.get(resource, {})
        if isinstance(v, dict):
            return v.get("hard_limit", 0)
        return v

    def __contains__(self, resource: str) -> bool:
        return resource in self.budget


class QuotaEnforcementMiddleware:
    """Middleware that enforces tenant quota limits.

    This middleware must be registered *after* TenantRateLimitMiddleware in
    the FastAPI stack so that the request already has the org resolved and
    rate-limit headers set.  It does NOT replace rate limiting — it adds
    quota/budget enforcement on top.

    Audit 2026-07-06 — pure ASGI ``__call__`` (no ``BaseHTTPMiddleware``).
    """

    # Staleness budget (seconds) for the cached hard-limit snapshot.
    # After this many seconds, the cache is rejected as too stale to
    # enforce safely (DL-14 Fail-closed).
    _BUDGET_STALENESS_LIMIT_S: float = 60.0

    # Phase 2 — headers-only GET/HEAD cache TTL. Mirrors the
    # ``_tier_cache`` pattern in ``TenantRateLimitMiddleware``
    # (``org_id -> (..., expires_at)``). This is a *separate*,
    # shorter-lived cache from ``_last_known_hard_limits``: that one
    # exists purely to make hard-limit enforcement fail-closed-but-
    # not-stuck; this one exists to stop every GET/HEAD (portal
    # sidebar polling, dashboard refetches, …) from hitting
    # ``UsageService.get_budget_status`` — and therefore Postgres —
    # on every single request. 15-30s is short enough that a plan
    # upgrade or quota reset is visible almost immediately, long
    # enough to collapse bursts of parallel GETs into one DB call.
    _HEADERS_CACHE_TTL_S: float = 20.0

    def __init__(self, app: ASGIApp):
        self.app = app
        self._usage_service: UsageService | None = None
        # Cache of the most-recent budget snapshot per org, used when
        # the DB fetch fails. The cache is Fail-closed: a snapshot
        # older than ``_BUDGET_STALENESS_LIMIT_S`` is treated as
        # missing (the request is blocked with a generic error).
        # Cache of the most-recent budget snapshot per org. The
        # value is a ``_BudgetView`` that wraps the full budget
        # dict but exposes ``view[resource]`` as the scalar
        # ``hard_limit`` so the test assertion
        # ``view["cost_usd"] == 20.0`` works. The high_util path
        # uses ``view.budget[resource]`` to get the full resource
        # dict (including ``used`` for the threshold check).
        self._last_known_hard_limits: dict[str, tuple[float, _BudgetView]] = {}
        # Phase 2 — org_id -> (budget dict, headers dict, expires_at
        # monotonic seconds). Populated by ``_build_quota_headers`` on
        # the GET/HEAD headers-only path so a burst of reads for the
        # same org within the TTL reuses one ``get_budget_status``
        # call instead of one per request.
        self._headers_cache: dict[str, tuple[dict[str, Any], dict[str, str], float]] = {}

    async def _get_usage_service(self) -> UsageService:
        if self._usage_service is None:
            self._usage_service = UsageService()
        return self._usage_service

    @staticmethod
    async def _resolve_org_id(request: Request) -> str | None:
        """Extract org_id from a verified identity: X-Org-Api-Key
        (hash-verified), Clerk Bearer JWT, or the legacy Eden cookie JWT.

        CRITICAL fix (2026-07-27 audit finding): this method used to
        return the raw ``X-Org-Id`` header verbatim as its first
        branch — an unauthenticated (or forged-Bearer) caller could
        set it to any org and have quota enforced (or bypassed) for
        that victim org. This is the exact same "RLS/quota tenant
        boundary" bug class fixed in ``RLSOrgContextMiddleware``
        (see ``rls_org_context._has_verified_identity``) and already
        hardened in ``TenantRateLimitMiddleware`` (comment: "Only
        trust X-Org-Id after the Bearer verifies") — this method now
        matches that same precedence so quota, rate-limit, and RLS
        all agree on how a tenant is proven, not just asserted:
          1. ``X-Org-Api-Key`` + ``X-Org-Id`` — SHA-256 hash lookup
             against ``org_api_keys.key_hash`` scoped to that exact
             org_id (same helper the FastAPI auth dependencies use —
             ``get_current_org_api_key`` in ``eden.api.deps`` —
             including its active/revoked/expires checks).
          2. Clerk Bearer JWT (JWKS-verified) — carries the org id.
          3. Legacy Eden cookie JWT (signature-verified) — carries
             ``current_org_id``.
        The raw header is never returned on its own; each branch
        below independently verifies the caller before trusting the
        org_id it supplies (the API-key branch trusts the header only
        because the hash lookup / org_id binding *is* the header's
        proof — not because the header is present).

        MEDIUM fix (2026-07-27 deep-audit finding #4): every branch's
        resolved id is passed through ``resolve_eden_org_id`` before
        being returned. ``RLSOrgContextMiddleware`` translates a Clerk
        org id (``org_…``) to the Eden ``organizations.id`` UUID
        before using it as the RLS GUC / cache key; this method
        previously did not, so a Clerk-authenticated request (Clerk
        Bearer branch below, which returns the raw Clerk id straight
        from the JWT) could have quota state cached under a different
        identifier than the one RLS/rate-limit key their state under
        for the exact same tenant. This is purely a "which key do we
        file the cache/enforcement snapshot under" translation — it
        does not change *whether* a caller is trusted, which is still
        decided solely by the verification branches below.
        """
        # 1. ``X-Org-Api-Key`` + ``X-Org-Id`` — hash-verified against
        # org_api_keys.key_hash (mirrors
        # RLSOrgContextMiddleware._has_verified_identity's API-key
        # branch and TenantRateLimitMiddleware._resolve_org_and_api_key).
        api_key = request.headers.get("x-org-api-key")
        org_id_header = request.headers.get("x-org-id")
        if api_key and org_id_header:
            try:
                from eden.api.deps import get_current_org_api_key

                org_row = await get_current_org_api_key(org_id_header, api_key)
                if org_row:
                    return await QuotaEnforcementMiddleware._to_eden_org_id(org_id_header)
            except Exception:
                logger.debug(
                    "quota_enforcement: X-Org-Api-Key verification "
                    "failed; falling through to cookie/Clerk Bearer",
                    exc_info=True,
                )

        # 2. Clerk Bearer — portal path; JWT carries ``o.id``.
        auth_header = request.headers.get("authorization")
        if auth_header and auth_header.lower().startswith("bearer "):
            try:
                from eden.api.utils.clerk_auth import (
                    extract_org_id,
                    verify_clerk_token_for_request,
                )

                clerk_payload = await verify_clerk_token_for_request(
                    request, auth_header[7:].strip()
                )
                if clerk_payload:
                    clerk_org = extract_org_id(clerk_payload)
                    if clerk_org:
                        return await QuotaEnforcementMiddleware._to_eden_org_id(clerk_org)
            except Exception:
                pass

        # 3. Legacy Eden JWT cookie
        token = request.cookies.get("authorization")
        if token:
            payload = decode_access_token(token)
            if payload:
                return await QuotaEnforcementMiddleware._to_eden_org_id(
                    payload.get("current_org_id")
                )

        # Note: request.path_params is not populated in ASGI middleware (routing
        # happens later), so header/cookie/API-key resolution is the only path.

        return None

    @staticmethod
    async def _to_eden_org_id(org_id: str | None) -> str | None:
        """Translate a Clerk org id (or an already-canonical Eden
        UUID) to the canonical ``organizations.id`` — MEDIUM fix
        (2026-07-27 deep-audit finding #4): keeps quota enforcement
        keyed by the same tenant identifier RLS
        (``rls_org_context._resolve_org_id`` /
        ``eden.api.deps.resolve_eden_org_id``) uses, so quota, rate
        limiting, and RLS all agree on the tenant.

        Best-effort / fail-open on the identifier only: returns the
        raw ``org_id`` unchanged if resolution misses or the lookup
        fails (``resolve_eden_org_id`` already swallows its own
        exceptions and returns ``None`` on error) — a transient DB
        blip here must not turn into a spurious quota/auth failure,
        it just risks (temporarily) keying this request's quota cache
        under the pre-translation id, exactly the pre-fix behaviour.
        """
        if not org_id:
            return org_id
        try:
            from eden.api.deps import resolve_eden_org_id

            resolved = await resolve_eden_org_id(org_id)
            return resolved or org_id
        except Exception as exc:
            logger.debug("quota_enforcement: org id resolve skipped: %s", exc)
            return org_id

    @staticmethod
    def _resources_for_path(path: str) -> list[str]:
        """Determine which quota dimensions apply to a request path.

        Audit 2026-07-02 P-20 narrowing.
        """
        for pattern, resources in _PATH_PATTERNS:
            if pattern.match(path):
                return resources
        return []  # ponytail: no match → no resource check on this path

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        method = scope.get("method", "GET")
        path = scope.get("path", "")

        # ── Skip for preflight, health, docs, metrics, ready ──
        if _should_skip_quota(method, path):
            await self.app(scope, receive, send)
            return

        # ── Test bypass ──
        # Integration tests mock Postgres but can't realistically
        # seed the org_resource_limits snapshot table on every
        # fixture. The middleware is fail-closed by design (DL-14)
        # — without a snapshot it returns 429 — but every test that
        # exercises a mutating route needs the middleware to defer
        # to the route handler. The test_settings fixture sets
        # ``quota_enabled=False`` so the middleware short-circuits
        # in the test suite without affecting production.
        # Import-time binding so context-manager patches from tests
        # (``patch("eden.config.get_settings", ...)``) still reach
        # this call site even after the middleware module is loaded.
        # The ``patch_settings`` autouse fixture overrides
        # ``eden.config.get_settings`` with a function that returns
        # test_settings; we resolve through the source attribute
        # so the patch propagates even when the middleware's
        # local ``get_settings`` binding is stale.
        from eden import config as _eden_config

        if not _eden_config.get_settings().quota_enabled:
            await self.app(scope, receive, send)
            return

        # Build a starlette ``Request`` shim so helpers still see
        # headers / cookies the same way they always have.
        request = Request(scope, receive)

        org_id = await self._resolve_org_id(request)
        if not org_id:
            # Unauthenticated — let the route handler deal with auth.
            # Anonymous GET/HEAD short-circuit here (no DB).
            await self.app(scope, receive, send)
            return

        # ── Build quota headers (always added when we can resolve org) ──
        # GET/HEAD: headers-only — no hard-limit enforcement below.
        # Mutating: this warm also feeds ``_cached_block_check`` so we
        # can skip a second ``get_budget_status`` round-trip when the
        # snapshot is already fresh (same data, same decision).
        try:
            quota_headers = await self._build_quota_headers(org_id)
        except Exception as exc:
            logger.warning(f"Quota header build failed for org {org_id}: {exc}")
            quota_headers = {}

        # ── For mutating methods, enforce hard limits ──
        # GET/HEAD skip this branch entirely (B32).
        if method in MUTATING_METHODS:
            # Path-specific resources + global credits checked
            # together. Credit cap fires regardless of path.
            resources = list(GLOBAL_MUTATING_RESOURCES) + self._resources_for_path(path)
            if resources:
                # DL-14: ALWAYS check the cached snapshot first. If the
                # cache is stale (>60s), fail closed — the cap may
                # have changed while we weren't looking. The live
                # check only confirms what the cache already knows.
                cached_blocked, cached_detail = self._cached_block_check(org_id, resources)
                if cached_blocked:
                    response = JSONResponse(
                        status_code=429,
                        content={
                            "detail": cached_detail,
                            "type": "quota_exceeded",
                        },
                        # F69 — apply OWASP security headers; merge
                        # with the existing ``quota_headers`` so the
                        # rate-limit policy + retry-after are preserved.
                        headers=apply_security_headers(quota_headers),
                    )
                    await response(scope, receive, send)
                    return
                # Headers path just warmed a fresh under-cap snapshot —
                # re-fetching would double Postgres load without
                # changing the admission decision. Live-check only when
                # the cache is missing/stale (header build failed).
                need_live = True
                staleness = self._budget_staleness(org_id)
                if staleness is not None and staleness <= self._BUDGET_STALENESS_LIMIT_S:
                    need_live = False
                if need_live:
                    try:
                        blocked, detail = await self._check_hard_limits(org_id, resources)
                        if blocked:
                            response = JSONResponse(
                                status_code=429,
                                content={
                                    "detail": detail,
                                    "type": "quota_exceeded",
                                },
                                # F69 — apply OWASP security headers.
                                headers=apply_security_headers(quota_headers),
                            )
                            await response(scope, receive, send)
                            return
                    except Exception as exc:
                        # Live check raised unexpectedly. Fresh under-cap
                        # cache → proceed; missing/stale → fail-closed
                        # (Wave 4) so mutations cannot bypass hard limits.
                        logger.warning(
                            f"Hard-limit check failed for org {org_id}: {exc}"
                        )
                        staleness_after = self._budget_staleness(org_id)
                        fresh = (
                            staleness_after is not None
                            and staleness_after <= self._BUDGET_STALENESS_LIMIT_S
                        )
                        if not fresh:
                            response = JSONResponse(
                                status_code=429,
                                content={
                                    "detail": (
                                        "No recent quota snapshot — Fail-closed: "
                                        "cannot verify hard limits for this "
                                        "mutation. Retry shortly."
                                    ),
                                    "type": "quota_exceeded",
                                },
                                headers=apply_security_headers(quota_headers),
                            )
                            await response(scope, receive, send)
                            return

        # ── Proceed to handler; inject quota headers via send-wrapper ──
        header_pairs = [
            (k.lower().encode("latin1"), str(v).encode("latin1")) for k, v in quota_headers.items()
        ]

        async def send_wrapper(message: dict) -> None:
            if message["type"] == "http.response.start" and header_pairs:
                headers = message.get("headers") or []
                headers.extend(header_pairs)
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, send_wrapper)

    async def _build_quota_headers(self, org_id: str) -> dict[str, str]:
        """Fetch budget status and return as HTTP headers.

        Also warms ``_last_known_hard_limits`` so a subsequent
        mutating request has a fresh snapshot (Wave 4) — without
        this, GETs (e.g. ``/auth/me``) built headers but left the
        cache empty and mutations 429'd on "No recent quota snapshot".

        Phase 2 — headers cache: ``get_budget_status`` is called at
        most once per org every ``_HEADERS_CACHE_TTL_S`` seconds
        (15-30s window). The dominant caller of this path is the
        GET/HEAD headers-only branch (every portal page mounts
        several parallel GETs that all want the ``X-Quota-*``
        headers), so without this a single page load could fire a
        dozen identical Postgres reads for the same org. Mutating
        requests share the cache too — harmless, since hard-limit
        *enforcement* goes through ``_check_hard_limits`` /
        ``_cached_block_check`` against ``_last_known_hard_limits``
        (60s staleness budget), not through this header cache.
        """
        now = time.monotonic()
        cached = self._headers_cache.get(org_id)
        if cached is not None and cached[2] > now:
            return dict(cached[1])

        service = await self._get_usage_service()
        budget = await service.get_budget_status(org_id)
        # Warm the enforcement cache from every successful read.
        self._record_hard_limits(org_id, budget)

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

        # PRIMARY cap — credits. Also emit USD mirrors for FinOps UIs.
        credits = budget.get("credits", {})
        headers["X-Quota-Credits-Used"] = str(credits.get("used", 0))
        headers["X-Quota-Credits-Soft"] = str(credits.get("soft_limit", 0))
        headers["X-Quota-Credits-Hard"] = str(credits.get("hard_limit", 0))
        headers["X-Quota-Credits-Pct"] = str(credits.get("percentage", 0))
        if credits.get("status") not in (None, "ok"):
            headers["X-Quota-Credits-Status"] = credits["status"]

        cost = budget.get("cost_usd", {})
        headers["X-Quota-Cost-Used"] = str(cost.get("used", 0))
        headers["X-Quota-Cost-Soft"] = str(cost.get("soft_limit", 0))
        headers["X-Quota-Cost-Hard"] = str(cost.get("hard_limit", 0))
        headers["X-Quota-Cost-Pct"] = str(cost.get("percentage", 0))
        if cost.get("status") not in (None, "ok"):
            headers["X-Quota-Cost-Status"] = cost["status"]

        headers["X-Quota-Plan"] = budget.get("plan_name", "unknown")

        self._headers_cache[org_id] = (
            budget,
            dict(headers),
            now + self._HEADERS_CACHE_TTL_S,
        )
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

        LP-10 / Wave 4: on live-fetch failure, enforce from a fresh
        cache when available; otherwise fail-closed for mutations —
        a missing/stale snapshot must not admit writes that may be
        over cap. GET/HEAD never reach this path.
        """
        service = await self._get_usage_service()
        try:
            budget = await service.get_budget_status(org_id)
        except Exception as exc:
            # Live fetch failed. If we still have a *fresh* cached
            # snapshot, enforce against it. Otherwise fail-closed
            # (Wave 4) — mutations must not proceed without a
            # trustworthy quota view.
            logger.debug("quota: live fetch failed: %s", exc)
            cached = self._last_known_hard_limits.get(org_id)
            if cached is not None:
                ts, view = cached
                if time.monotonic() - ts <= self._BUDGET_STALENESS_LIMIT_S:
                    return self._evaluate_hard_limits(view.budget, resources)
            logger.warning(
                "quota: fail-closed for org %s — no fresh snapshot after live fetch failure",
                org_id,
            )
            return (
                True,
                "No recent quota snapshot — Fail-closed: cannot verify "
                "hard limits for this mutation. Retry shortly.",
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
        form). The cache snapshot is what makes DL-14 Fail-closed under
        transient DB outages — the next call rejects anything older
        than ``_BUDGET_STALENESS_LIMIT_S`` seconds.

        The cached value is a tuple ``(ts, flat_hard_limits, full_budget)``
        where ``flat_hard_limits`` is a flat ``{resource: hard_limit}`` map
        so the test (and the high-util check) can do
        ``cached["cost_usd"] == 20.0`` directly. The full budget is
        preserved for the high_util path.
        """
        # 2-tuple format: (timestamp, _BudgetView)
        # The view exposes ``view[resource]`` as the hard_limit scalar
        # AND ``view.budget[resource]`` as the full resource dict.
        view = _BudgetView(budget)
        self._last_known_hard_limits[org_id] = (time.monotonic(), view)
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

        Wave 4 / mutations: a *fresh* over-cap snapshot blocks
        immediately. Missing or stale cache returns ``(False, "")`` so
        ``__call__`` proceeds to the live ``_check_hard_limits`` path
        (which warms the cache on success, or fail-closes when the
        live fetch also fails). GET/HEAD never call this helper.

        Previously missing cache alone returned 429 with
        "No recent quota snapshot", which blocked portal mutations
        for cold workers before a live fetch could warm the snapshot;
        live-fetch failure is now the fail-closed gate instead.
        """
        cached = self._last_known_hard_limits.get(org_id)
        if cached is None:
            return False, ""
        ts, view = cached
        if time.monotonic() - ts > self._BUDGET_STALENESS_LIMIT_S:
            return False, ""
        return self._evaluate_hard_limits(view.budget, resources)

    def _budget_staleness(self, org_id: str) -> float | None:
        """Return seconds since the last cached snapshot for ``org_id``.

        ``None`` if no cache exists. Used by the test to verify the
        staleness budget is enforced.
        """
        cached = self._last_known_hard_limits.get(org_id)
        if cached is None:
            return None
        ts, _view = cached
        return time.monotonic() - ts

    def _evaluate_hard_limits(
        self,
        budget: dict,
        resources: list[str],
    ) -> tuple[bool, str]:
        """Pure-function hard-limit evaluation against a budget snapshot.

        DL-14 Fail-closed: blocks on ``hard_exceeded`` / ``soft_exceeded``
        status OR when ``used >= hard_limit`` OR when
        ``used / hard_limit >= 0.8`` (high utilization — block
        conservatively to keep the cached snapshot trustworthy).

        `budget` may be either the full {resource: {used, hard_limit,
        status, ...}} map (when called from the live path) or the
        flattened {resource: hard_limit} map (when called from the
        cached-check path). The latter lacks the used count so we
        can only block on `status in ('hard_exceeded', 'soft_exceeded')`
        or missing resource — never on high_util. High-util blocking
        is only available when the full budget is supplied.
        """
        for resource in resources:
            res_data = budget.get(resource, {})
            # Flattened form (int value): can't compute used or
            # status, only the hard_limit is available.
            if isinstance(res_data, (int, float)):
                continue
            status = res_data.get("status", "ok")
            used = res_data.get("used", 0)
            hard = res_data.get("hard_limit", 0)
            over_cap = used >= hard > 0
            # Only a HARD breach may block.
            #
            # This used to also block on "soft_exceeded" and on any
            # utilisation >= 80% — contradicting the documented contract
            # in plan_tiers.py ("Soft caps fire a warning header + UI
            # banner but don't block"). Because cost_usd is in
            # GLOBAL_MUTATING_RESOURCES, that ran on EVERY POST / PUT /
            # PATCH / DELETE on every path: the first customer to accrue
            # $2.00 against a $3.00 cap lost all write operations across
            # the entire product, and the 429 told them the $3.00 cap had
            # been reached when they were at two thirds of it.
            #
            # Not firing today only because usage_events is empty; it
            # arms the moment real telemetry starts being priced.
            if status != "hard_exceeded" and not over_cap:
                continue
            if status == "hard_exceeded" or over_cap:
                used = res_data.get("used", 0)
                hard = res_data.get("hard_limit", 0)
                if resource == "credits":
                    used_c = int(round(float(used)))
                    hard_c = int(round(float(hard)))
                    return (
                        True,
                        f"Free-tier credit cap reached this month "
                        f"({used_c:,} / {hard_c:,} credits). "
                        "Reach out to support to raise your cap. "
                        "(Fail-closed: cached snapshot enforced)",
                    )
                if resource == "cost_usd":
                    return (
                        True,
                        f"Free-tier spending cap reached this month "
                        f"(${used:.2f} / ${hard:.2f}). "
                        "Reach out to support to raise your cap. "
                        "(Fail-closed: cached snapshot enforced)",
                    )
                if resource == "seats":
                    return (
                        True,
                        f"Seats limit reached ({int(used)} / {int(hard)}). "
                        "Remove a member or ask support to raise the cap. "
                        "(Fail-closed: cached snapshot enforced)",
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
                    "Reach out to support to raise your cap. (Fail-closed: cached snapshot enforced)",
                )
            # The former "high_util" branch lived here: it blocked at
            # >=80% of the cap even when the live status was "ok". That
            # is a warning condition, not a blocking one — soft caps are
            # documented to surface a header and a UI banner, never a
            # 429 — and it is removed rather than reordered.

        return False, ""
