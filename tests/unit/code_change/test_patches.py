"""Cat 23 Code-Change STUB surface tests — verify the two-stage opt-in
chokepoint blocks every side-effect when the feature is off.
"""

import pytest
from fastapi.testclient import TestClient


class TestTwoStageOptIn:
    """Cat 23 design: nothing mutates unless BOTH `code_change_enabled`
    AND (`auto_pr_enabled` or `auto_revert_enabled`) are true. The
    audit pinned this as the chokepoint (see Cat 23 STUB surface shipped
    memory).
    """

    def test_propose_blocked_when_flag_off(
        self, authenticated_client: TestClient, monkeypatch
    ):
        from eden.config import get_settings
        s = get_settings()
        monkeypatch.setattr(s, "code_change_enabled", False, raising=False)
        # POST a propose; the two-stage guard should 4xx.
        r = authenticated_client.post(
            "/orgs/test-org/intelligence/code-change/patches",
            json={"title": "fix typo", "diff": "--- a\n+++ b\n"},
        )
        assert r.status_code in (400, 403, 404, 422)

    def test_propose_blocked_when_auto_pr_off(
        self, authenticated_client: TestClient, monkeypatch
    ):
        from eden.config import get_settings
        s = get_settings()
        monkeypatch.setattr(s, "code_change_enabled", True, raising=False)
        monkeypatch.setattr(s, "auto_pr_enabled", False, raising=False)
        monkeypatch.setattr(s, "auto_revert_enabled", False, raising=False)
        r = authenticated_client.post(
            "/orgs/test-org/intelligence/code-change/patches",
            json={"title": "fix typo", "diff": "--- a\n+++ b\n"},
        )
        # Two-stage: enabled but no auto-write perms → blocked.
        assert r.status_code in (400, 403, 404, 422)
