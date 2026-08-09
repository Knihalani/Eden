"""Onboarding must never render a failure as an empty or successful state.

Every defect below was found while auditing the path a brand-new
customer walks on day one. They share one shape: a degraded path that
returns a success-shaped value, so "we are broken" and "you have no
data yet" become the same screen — and the customer's rational response
is to go debug their own code.

  1. GET /orgs returned 200 [] when the caller's Eden user row had not
     been provisioned yet. The portal renders the "Create workspace"
     empty state for [], so clicking it mints a SECOND org.
  2. The portal trace list returned [] both when Postgres was
     unreachable and when the query raised.
  3. Three Clerk webhook handlers logged and returned on an
     out-of-order event, and the route answered 200. Svix redelivers on
     non-2xx only, so 200 is a permanent ack and the event was dropped
     forever. Two production orgs have zero members because of this.
  4. ensure_clerk_membership skipped the membership INSERT whenever the
     Clerk JWT carried no `o.rol` claim. Not transient: it re-failed on
     every request forever, while get_current_org still granted access
     through a synthesized `_pending_sync` context. Result: an org with
     API keys and traces that is invisible to its own owner, because
     both GET /orgs and /auth/me INNER JOIN org_members.
"""

from __future__ import annotations

import inspect

import pytest


class TestOnboardingV2HonestyGate:
    def test_router_depends_on_v2_gate(self):
        from eden.api.routes import onboarding

        deps = list(onboarding.router.dependencies or [])
        assert deps, "v2 router must declare dependencies"
        # Gate lives on the router so every path 503s when the flag is off.
        assert onboarding._require_onboarding_v2_enabled in {
            getattr(d, "dependency", None) for d in deps
        }

    def test_default_settings_enable_v2_after_migration(self):
        from eden.config import Settings

        # Construct without loading .env so the ship-default is what we assert.
        s = Settings(
            _env_file=None,  # type: ignore[call-arg]
            jwt_secret="x" * 32,
            encryption_key="0123456789abcdef0123456789abcdef",
            session_secret="y" * 32,
        )
        assert s.onboarding_state_machine_v2_enabled is True

    def test_gate_raises_503_when_disabled(self, monkeypatch):
        from fastapi import HTTPException

        from eden.api.routes import onboarding

        class _S:
            onboarding_state_machine_v2_enabled = False

        monkeypatch.setattr(
            "eden.config.get_settings", lambda: _S()
        )
        with pytest.raises(HTTPException) as ei:
            onboarding._require_onboarding_v2_enabled()
        assert ei.value.status_code == 503
        assert "not yet migrated" in str(ei.value.detail).lower() or "disabled" in str(
            ei.value.detail
        ).lower()

    def test_missing_user_row_raises_401_rather_than_returning_empty(self):
        from eden.api.routes import orgs

        src = inspect.getsource(orgs.list_user_orgs)
        head = src.split("if not user_id:")[1][:600]
        assert "return []" not in head, (
            "a user who is still provisioning is not a user with zero "
            "orgs; returning [] makes the portal offer 'Create workspace' "
            "and the customer ends up with a duplicate org"
        )
        assert "401" in head or "HTTP_401_UNAUTHORIZED" in head, (
            "use the same 401 resolve_path_org_access raises for this "
            "condition; the portal maps it to the provisioning UX"
        )


class TestPortalTracesDistinguishesFailureFromEmpty:
    def test_no_database_raises_503(self):
        from eden.api.routes import portal

        src = inspect.getsource(portal.list_portal_traces)
        head = src.split("if client is None:")[1][:500]
        assert "return []" not in head, (
            "an unreachable database must not render as 'no traces yet'"
        )
        assert "503" in head

    def test_query_failure_raises_503(self):
        from eden.api.routes import portal

        src = inspect.getsource(portal.list_portal_traces)
        tail = src.split("except Exception")[1][:600]
        assert "return []" not in tail, (
            "a failed query must not render as 'no traces yet' — this is "
            "the worst failure mode during onboarding, because the "
            "customer goes off debugging their own SDK"
        )
        assert "503" in tail


class TestClerkWebhooksAskForRedelivery:
    """Svix redelivers on non-2xx ONLY. Returning is data loss."""

    def test_membership_missing_side_raises(self):
        from eden.api.routes import clerk_webhooks

        src = inspect.getsource(clerk_webhooks._upsert_membership)
        branch = src.split("if not eden_user or not eden_org:")[1][:1600]
        code = "\n".join(
            ln for ln in branch.splitlines() if not ln.strip().startswith("#")
        )
        assert "WebhookNotReadyError" in code, (
            "a membership event that arrives before its user/org must ask "
            "Clerk to redeliver, not answer 200 and drop the event"
        )
        assert not _has_bare_return(code)

    def test_org_without_resolvable_owner_raises(self):
        from eden.api.routes import clerk_webhooks

        src = inspect.getsource(clerk_webhooks._upsert_org)
        assert "WebhookNotReadyError" in src

    def test_user_email_collision_is_logged_and_raised(self):
        from eden.api.routes import clerk_webhooks

        src = inspect.getsource(clerk_webhooks._upsert_user)
        assert "UPDATE 0" in src, (
            "the recovery UPDATE only matches soft-deleted rows; when it "
            "matches nothing the handler must notice rather than fall "
            "through to a 200"
        )
        assert "logger.error" in src
        assert "WebhookNotReadyError" in src

    def test_error_type_exists_and_is_not_an_http_2xx_path(self):
        from eden.api.routes.clerk_webhooks import WebhookNotReadyError

        assert issubclass(WebhookNotReadyError, Exception)


def _has_bare_return(code: str) -> bool:
    return any(ln.strip() == "return" for ln in code.splitlines())


class TestMembershipSelfHealWritesWithoutARoleClaim:
    @pytest.mark.asyncio
    async def test_owner_gets_owner_role_when_jwt_omits_role(self, monkeypatch):
        from eden.api import deps

        captured: list[tuple] = []

        class FakeClient:
            async def fetchval(self, _q, org_id):
                return "user-1"  # this user owns the org

            async def execute(self, _q, *args):
                captured.append(args)
                return "INSERT 0 1"

        async def _fake_pg():
            return FakeClient()

        monkeypatch.setattr(deps, "get_postgres_client", _fake_pg)

        ok = await deps.ensure_clerk_membership("user-1", "org-1", None)
        assert ok is True, "no role claim must still create the membership"
        assert captured, "no INSERT was issued"
        assert "owner" in captured[0], f"expected owner role, got {captured[0]}"

    def test_every_call_site_is_gated_on_the_clerk_session_org(self):
        """Security property, pinned deliberately.

        ensure_clerk_membership now WRITES a row where it previously
        wrote none, so it matters that it can only ever be reached for
        an org Clerk's own JWT already asserts this user belongs to.

        Every call site must sit behind either `session_matches` (the
        Clerk session org equals the org in question) or an explicit
        IDOR check that 403s on mismatch. If someone adds an ungated
        call site, this fails — because at that point the function
        would be inventing membership for a foreign tenant.
        """
        import ast
        import inspect

        from eden.api import deps

        src = inspect.getsource(deps)
        tree = ast.parse(src)

        #: Functions whose org argument is, by construction, the Clerk
        #: session's own org — the whole function is the guard.
        session_scoped_funcs = {
            "ensure_clerk_org_from_session",
            "resolve_clerk_org_for_session",
        }

        offenders = []
        examined = []
        for func in ast.walk(tree):
            if not isinstance(func, ast.FunctionDef | ast.AsyncFunctionDef):
                continue
            if func.name == "ensure_clerk_membership":
                continue
            body_src = ast.get_source_segment(src, func) or ""
            if "ensure_clerk_membership(" not in body_src:
                continue
            examined.append(func.name)
            if func.name in session_scoped_funcs:
                continue
            # Otherwise the enclosing function must contain an explicit
            # session/IDOR guard.
            gated = (
                "session_matches" in body_src
                or "does not match session organization" in body_src
            )
            if not gated:
                offenders.append(f"{func.name}()")

        # A structural test that inspected nothing would pass silently,
        # which is the same class of bug this whole file is about.
        assert len(examined) >= 3, (
            f"expected to find several ensure_clerk_membership call "
            f"sites in deps.py; found {examined}. Either the calls moved "
            f"or this check has stopped checking anything."
        )
        assert not offenders, (
            "ungated ensure_clerk_membership call site(s) — membership "
            "must only be self-healed for the Clerk session's own org:\n"
            + "\n".join(offenders)
        )

    @pytest.mark.asyncio
    async def test_non_owner_gets_member_not_viewer(self, monkeypatch):
        from eden.api import deps

        captured: list[tuple] = []

        class FakeClient:
            async def fetchval(self, _q, org_id):
                return "someone-else"

            async def execute(self, _q, *args):
                captured.append(args)
                return "INSERT 0 1"

        async def _fake_pg():
            return FakeClient()

        monkeypatch.setattr(deps, "get_postgres_client", _fake_pg)

        ok = await deps.ensure_clerk_membership("user-1", "org-1", None)
        assert ok is True
        assert "member" in captured[0], (
            f"expected 'member' (the same default the webhook applies), "
            f"got {captured[0]}"
        )
        assert "viewer" not in captured[0], (
            "mapping a missing claim to viewer would wrongly demote"
        )
