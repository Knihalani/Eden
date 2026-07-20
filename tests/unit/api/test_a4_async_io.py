"""Wave-1 A4 async I/O done-when checks."""

from __future__ import annotations

import inspect


def _is_pure_asgi_mw(mw_cls) -> bool:
    return callable(mw_cls.__call__) and "dispatch" not in mw_cls.__dict__


def test_jsonx_dumps_loads_roundtrip():
    from eden.util import jsonx

    payload = {"a": 1, "b": ["x", 2], "c": {"d": True}}
    encoded = jsonx.dumps(payload)
    assert isinstance(encoded, str)
    assert jsonx.loads(encoded) == payload


def test_tier_cache_ttl_is_60():
    from eden.api.middleware.tenant_rate_limit import TenantRateLimitMiddleware

    mw = TenantRateLimitMiddleware(lambda s, r, send: None)
    assert mw._tier_cache_ttl == 60.0


def test_idempotency_quota_rls_are_pure_asgi():
    from eden.api.middleware.idempotency import IdempotencyMiddleware
    from eden.api.middleware.quota_enforcement import QuotaEnforcementMiddleware
    from eden.api.middleware.rls_org_context import RLSOrgContextMiddleware

    assert _is_pure_asgi_mw(IdempotencyMiddleware)
    assert _is_pure_asgi_mw(QuotaEnforcementMiddleware)
    assert _is_pure_asgi_mw(RLSOrgContextMiddleware)


def test_run_async_removed_from_gateway():
    import eden.api.routes.gateway as gateway

    assert not hasattr(gateway, "_run_async")
    assert "_run_async" not in gateway.__dict__


def test_last_seen_debounce_constants_exist():
    from eden.api import deps

    assert hasattr(deps, "_LAST_SEEN_DEBOUNCE_S")
    assert deps._LAST_SEEN_DEBOUNCE_S == 60.0


def test_org_id_cache_constants_exist():
    from eden.api import deps

    assert hasattr(deps, "_ORG_ID_CACHE_TTL_S")
    assert deps._ORG_ID_CACHE_TTL_S == 60.0


def test_user_id_cache_constants_exist():
    from eden.api import deps

    assert hasattr(deps, "_USER_ID_CACHE_TTL_S")
    assert deps._USER_ID_CACHE_TTL_S == 60.0
    assert hasattr(deps, "_ID_CACHE_MAX")
    assert deps._ID_CACHE_MAX == 4096


def test_clerk_user_cache_max_exists():
    from eden.api.utils import clerk_client

    assert hasattr(clerk_client, "_USER_CACHE_MAX")
    assert clerk_client._USER_CACHE_MAX == 2048


def test_billing_has_stripe_call():
    from eden.api.routes import billing

    assert hasattr(billing, "_stripe_call")
    assert inspect.iscoroutinefunction(billing._stripe_call)
