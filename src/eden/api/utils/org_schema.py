"""Organization schema helpers (optional columns across migration lag)."""

from __future__ import annotations

from typing import Any

_HAS_IS_PERSONAL: bool | None = None


async def organizations_have_is_personal(client: Any) -> bool:
    """True when ``organizations.is_personal`` exists (migration 046).

    Result is cached process-wide so ``/auth/me`` and ``GET /orgs``
    do not hit ``information_schema`` on every request.
    """
    global _HAS_IS_PERSONAL
    if _HAS_IS_PERSONAL is not None:
        return _HAS_IS_PERSONAL
    found = await client.fetchval(
        """
        SELECT EXISTS (
            SELECT 1
              FROM information_schema.columns
             WHERE table_schema = current_schema()
               AND table_name = 'organizations'
               AND column_name = 'is_personal'
        )
        """
    )
    _HAS_IS_PERSONAL = bool(found)
    return _HAS_IS_PERSONAL
