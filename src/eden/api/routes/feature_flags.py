"""Public feature-flag endpoint used by the portal to branch its UI.

This endpoint is intentionally unauthenticated: the portal must be able to
discover which navigation entries to render before the user signs in (e.g.
to hide the "Eval Harnesses" link in the public marketing chrome or in the
auth screens).

The endpoint only exposes boolean flags. It does not leak any other
settings, secrets, or environment information.
"""

import logging

from fastapi import APIRouter
from pydantic import BaseModel

from eden.config import get_settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/feature-flags", tags=["feature-flags"])


class FeatureFlagsResponse(BaseModel):
    """Public boolean feature flags exposed to the portal."""

    experiments_v1: bool
    f70: bool


@router.get("", response_model=FeatureFlagsResponse)
async def get_feature_flags() -> FeatureFlagsResponse:
    """Return boolean feature flags.

    Currently exposes:
    - `experiments_v1`: when true, legacy experiments / eval-harness
      routes are enabled. When false (default), the corresponding routes
      return 404 and the portal hides the "Eval Harnesses" navigation entry.
    - `f70`: when true, ChatSidebar (in-product AI copilot) is shown.
      Maps to ``features.f70`` / ``FEATURES_F70`` (default true).

    Settings are read at request time (not at module load time) so that
    tests can monkeypatch EXPERIMENTS_V1 between requests.
    """
    settings = get_settings()
    return FeatureFlagsResponse(
        experiments_v1=bool(settings.experiments_v1),
        f70=bool(getattr(settings, "features_f70", True)),
    )
