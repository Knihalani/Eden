"""E2E journey test for the marketplace.

This is a placeholder for the full Playwright journey that
will live under tests/e2e/ (see §10.1). The test is here to:

  1. Reserve the file path so the imports in the daily cron
     workflow resolve.
  2. Document the journey in code so the Playwright spec can
     be ported from it without re-discovering the flow.

Journey (Playwright, to be ported):
  1. Sign in as a customer with at least one published env card.
  2. Navigate to /marketplace.
  3. Verify the featured row renders (or is hidden when empty).
  4. Type in the search box → assert that results narrow.
  5. Switch the quality filter to "high" → assert that only
     high-quality cards remain.
  6. Click a card tile → assert that the URL matches /marketplace/{slug}.
  7. On the detail page, click "Fork" → fill the slug, submit.
  8. Assert that the user is redirected to the forked draft
     and the fork count on the parent has incremented by 1.
"""
from __future__ import annotations

import pytest


@pytest.mark.skip(reason="Playwright harness not yet installed; see §10.1")
def test_marketplace_journey() -> None:
    """See module docstring for the full journey."""
    raise NotImplementedError
