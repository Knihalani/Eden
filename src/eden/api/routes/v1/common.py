"""Shared utilities for Public API v1 routes.

Provides a unified auth dependency that accepts either cookie-based
session auth or API-key-based programmatic auth.
"""

from typing import Optional

from fastapi import Header, HTTPException, status
from fastapi.params import Depends

from eden.api.deps import get_optional_user, get_current_org_api_key


async def get_v1_caller(
    user: Optional[dict] = Depends(get_optional_user),
    x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
    x_org_api_key: Optional[str] = Header(None, alias="X-Org-Api-Key"),
) -> dict:
    """Resolve caller identity from cookie or API key.

    Returns a dict with at minimum ``user_id`` and ``auth_method``.
    For API key auth, also includes ``org_id``, ``scopes``, and ``key_id``.

    Raises 401 if neither auth method is provided.
    """
    if user:
        return {
            "user_id": user["user_id"],
            "email": user.get("email"),
            "current_org_id": user.get("current_org_id"),
            "auth_method": "cookie",
        }

    if x_org_api_key and x_org_id:
        try:
            org = await get_current_org_api_key(x_org_id, x_org_api_key)
            return {
                "user_id": f"apikey:{org['key_id']}",
                "org_id": org["org_id"],
                "scopes": org.get("scopes", []),
                "key_id": org["key_id"],
                "auth_method": "api_key",
            }
        except HTTPException:
            pass

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Authentication required. Provide either a session cookie or X-Org-Id + X-Org-Api-Key headers.",
    )
