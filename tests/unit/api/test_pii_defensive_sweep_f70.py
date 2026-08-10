"""F70 — Defensive PII redaction sweep on remaining log sites.

F65 closed the obvious PII-in-logs sites (compliance + email_service).
F66 added defensive redaction in auth.py (honeypot + dispatch exc).
F70 closes the last 5 candidate sites the audit identified:

* ``clerk_client.get_user`` — ``ClerkAPIError`` on a 4xx contains
  ``response.text[:300]`` which Clerk often fills with the user's
  email + their internal id. Pre-F70 the raw ``exc`` was logged;
  post-F70 it runs through ``redact_all``.
* ``auth.Password rehash`` — the ``user_id`` is an internal UUID
  (not PII), but F70 wraps it through ``redact_all`` for
  defense-in-depth in case the id format ever changes.
* ``optimization.redis hget`` — ``org_id`` and ``month_key`` are
  internal IDs; ``exc`` is wrapped through ``redact_all`` for the
  long tail.
* ``sidebar_prefs.fetchrow`` — same pattern.
* ``sidebar_prefs.upsert`` — same pattern.

This test pins the redaction at the source level so a future
refactor that re-introduces a raw ``exc`` log fails the test.
"""

from __future__ import annotations

import inspect

import pytest

from eden.api.utils.redact import redact_all


class TestF70ClerkClientRedaction:
    """``clerk_client.get_user`` MUST run the upstream ``exc``
    through ``redact_all`` before logging. ``ClerkAPIError`` on
    a 4xx contains ``response.text[:300]`` which Clerk often
    fills with the user's email."""

    def test_clerk_client_imports_redact_all(self) -> None:
        from eden.api.utils import clerk_client

        src = inspect.getsource(clerk_client)
        assert "from eden.api.utils.redact import redact_all" in src, (
            "F70 regression: clerk_client.py no longer imports redact_all"
        )

    def test_clerk_client_logs_redact_all(self) -> None:
        from eden.api.utils import clerk_client

        src = inspect.getsource(clerk_client)
        # The get_user log line MUST run the exc through redact_all.
        assert "redact_all(str(exc))" in src, (
            "F70 regression: clerk_client.get_user is logging "
            "ClerkAPIError without redact_all — Clerk's 4xx body "
            "may include the user's email"
        )
        # Negative pin: the unredacted form MUST NOT be in the source.
        bad = '''logger.warning(
                "get_user(%s) failed: %s",
                clerk_id,
                exc,
            )'''
        assert bad not in src, (
            "F70 regression: clerk_client.get_user is logging "
            "ClerkAPIError as-is"
        )


class TestF70AuthPasswordRehash:
    """``auth.py`` Password rehash path MUST run the ``user_id``
    through ``redact_all`` for defense-in-depth."""

    def test_password_rehash_logs_redact_all(self) -> None:
        from eden.api.routes import auth

        src = inspect.getsource(auth)
        # The Password rehash log line MUST run user_id through redact_all.
        # Find the marker "Password rehash failed for user"
        marker_idx = src.find("Password rehash failed for user")
        assert marker_idx != -1, (
            "F70 test setup: 'Password rehash failed for user' not "
            "found in auth.py source"
        )
        window = src[max(0, marker_idx - 50): marker_idx + 300]
        assert "redact_all" in window, (
            "F70 regression: auth.py Password rehash log no longer "
            "runs user_id through redact_all"
        )


class TestF70OptimizationRedisHget:
    """``optimization.py`` overview fallback log MUST run the exc
    through ``redact_all``.

    FEAT-171 (2026-08-06) removed the Redis cost-hash read whose
    ``redis hget failed for org=`` log line this class used to pin; the
    live fallback log site is now the overview route's last-resort
    handler (``optimization overview fallback for org=``)."""

    def test_optimization_imports_redact_all(self) -> None:
        from eden.api.routes import optimization

        src = inspect.getsource(optimization)
        assert "from eden.api.utils.redact import redact_all" in src, (
            "F70 regression: optimization.py no longer imports redact_all"
        )

    def test_optimization_logs_redact_all(self) -> None:
        from eden.api.routes import optimization

        src = inspect.getsource(optimization)
        marker_idx = src.find("optimization overview fallback for org=")
        assert marker_idx != -1, (
            "F70 test setup: 'optimization overview fallback for org=' not "
            "found in optimization.py source"
        )
        window = src[max(0, marker_idx - 50): marker_idx + 400]
        assert "redact_all(str(exc))" in window, (
            "F70 regression: optimization.py overview fallback log no "
            "longer runs the exc through redact_all"
        )


class TestF70SidebarPrefsRedaction:
    """``sidebar_prefs.py`` MUST run both log sites through
    ``redact_all``."""

    def test_sidebar_prefs_imports_redact_all(self) -> None:
        from eden.api.routes import sidebar_prefs

        src = inspect.getsource(sidebar_prefs)
        assert "from eden.api.utils.redact import redact_all" in src, (
            "F70 regression: sidebar_prefs.py no longer imports redact_all"
        )

    @pytest.mark.parametrize(
        "marker",
        [
            "sidebar_prefs: fetchrow failed for user=",
            "sidebar_prefs: upsert failed for user=",
        ],
    )
    def test_sidebar_prefs_log_redacts_exc(self, marker: str) -> None:
        from eden.api.routes import sidebar_prefs

        src = inspect.getsource(sidebar_prefs)
        marker_idx = src.find(marker)
        assert marker_idx != -1, (
            f"F70 test setup: '{marker}' not found in sidebar_prefs.py"
        )
        window = src[max(0, marker_idx - 50): marker_idx + 400]
        assert "redact_all(str(exc))" in window, (
            f"F70 regression: sidebar_prefs.py '{marker}' log no "
            f"longer runs the exc through redact_all"
        )


class TestF70RedactAllOnUuids:
    """Defense-in-depth: ``redact_all`` on internal UUIDs MUST be
    a no-op. If the helper ever starts scrubbing UUIDs by accident,
    the F70 redactions would break log diagnostics."""

    def test_redact_all_on_uuid_is_noop(self) -> None:
        uuid_str = "550e8400-e29b-41d4-a716-446655440000"
        assert redact_all(uuid_str) == uuid_str

    def test_redact_all_on_clerk_id_is_noop(self) -> None:
        clerk_id = "user_2abc123def456ghi789"
        assert redact_all(clerk_id) == clerk_id

    def test_redact_all_on_org_id_is_noop(self) -> None:
        org_id = "org_2abc123def456ghi789"
        assert redact_all(org_id) == org_id

    def test_redact_all_on_month_key_is_noop(self) -> None:
        month_key = "2026-07"
        assert redact_all(month_key) == month_key

    def test_redact_all_does_redact_email(self) -> None:
        # The helper MUST still redact emails — that's the whole point.
        # This test guards against an over-eager future refactor that
        # accidentally turns the helper into a no-op.
        assert redact_all("Email alice@example.com") == "Email ***"
