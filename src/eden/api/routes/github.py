"""GitHub App integration routes — the onboarding wizard's repo-link flow.

Routes:

* ``GET  /integrations/github/configured``
    Public — returns whether the Eden instance has a GitHub App
    configured. The wizard's "Connect GitHub" step calls this first
    to decide whether to render the connect button or the "skip"
    fallback.
* ``GET  /integrations/github/authorize``
    Owner/admin — returns the URL to redirect the user to so they
    can install the Eden App on a GitHub org + grant repos.
* ``GET  /integrations/github/callback``
    Public (GitHub redirects users here) — verifies the state token,
    persists the installation, redirects back to the wizard.
* ``POST /integrations/github/webhook``
    Public (GitHub posts here) — verifies the X-Hub-Signature-256
    header, updates ``onboarding_pr_runs.status`` on ``pull_request``
    events.
* ``GET  /orgs/{org_id}/github/installations``
    Member — list installations for the org.
* ``GET  /orgs/{org_id}/github/repos``
    Owner/admin — list repos the org's installations have access to.
* ``POST /orgs/{org_id}/github/integrate``
    Owner/admin — runs detection + opens the SDK-integration PR.
* ``GET  /orgs/{org_id}/onboarding/state``
    Member — fetch the org's wizard state.
* ``POST /orgs/{org_id}/onboarding/state``
    Member — patch the wizard state (advance, mark agent_setup_choice).
* ``GET  /orgs/{org_id}/onboarding/pr-runs``
    Member — list integration PR runs.

RBAC: the `integrations:write` permission gates the write-side routes
(``authorize``, ``integrate``). The repo list + state-read routes are
member-level, but the wizard hides them client-side from
member/viewer roles so they only see the "ask your admin" callout.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from starlette.responses import RedirectResponse

from eden.api.deps import (
    get_current_user,
    require_org_member,
    require_org_permission_dep,
)
from eden.api.utils.redact import redact_all
from eden.config import get_settings
from eden.integrations.onboarding_agent import build_integration_for_repo
from eden.integrations.github import (
    GitHubAPIError,
    GitHubConfigError,
    GitHubOAuthClient,
    is_configured,
    verify_webhook_signature,
)
from eden.providers.pr import GitHubPRProvider, PRCreateRequest
from eden.providers.repo import FileEntry, GitHubRepoProvider
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)
settings = get_settings()

# Two routers — one for the public integration surface, one for the
# per-org surface. Both registered in app.py.
public_router = APIRouter(prefix="/integrations/github", tags=["integrations"])
org_router = APIRouter(prefix="/orgs/{org_id}", tags=["onboarding"])

# Installation tokens are minted on demand. Cache for the token's
# lifetime so we don't hammer the GitHub App JWT endpoint.
_token_cache: dict[int, Any] = {}

# Manifest files the integration flow inspects. Stays small so we
# don't blow REST quota — the SDK integrator only needs these.
_MANIFEST_FILES = (
    "requirements.txt",
    "pyproject.toml",
    "package.json",
    "setup.py",
    "tsconfig.json",
    ".eden/config.yaml",
)


# ── Schemas ──────────────────────────────────────────────────────────


class ConfiguredResponse(BaseModel):
    configured: bool
    app_slug: str | None = None


class AuthorizeResponse(BaseModel):
    install_url: str
    state: str


class InstallationOut(BaseModel):
    installation_id: int
    account_login: str
    account_type: str
    installed_at: str
    suspended: bool


class RepoOut(BaseModel):
    full_name: str
    name: str
    owner: str
    default_branch: str
    private: bool
    description: str = ""
    html_url: str
    installation_id: int


class IntegrateRequest(BaseModel):
    installation_id: int
    repo_full_name: str
    agent_id: str | None = None
    agent_name: str | None = None


class ClaimInstallationRequest(BaseModel):
    installation_id: int


class PRRunOut(BaseModel):
    id: str
    org_id: str
    agent_id: str | None
    repo_full_name: str
    framework: str | None
    language: str | None
    branch: str | None
    pr_number: int | None
    pr_url: str | None
    status: str
    detail: dict
    created_at: str
    opened_at: str | None
    merged_at: str | None
    closed_at: str | None


class OnboardingStateOut(BaseModel):
    org_id: str
    step: str
    org_setup_choice: str | None = None
    agents_onboarded: list[dict] = Field(default_factory=list)
    completed_by_users: list[str] = Field(default_factory=list)
    updated_at: str


class OnboardingStatePatch(BaseModel):
    step: str | None = None
    org_setup_choice: str | None = None
    mark_agent_onboarded: dict | None = None  # {agent_id, agent_name}


# ── Helpers ──────────────────────────────────────────────────────────


async def _client_for(installation_id: int) -> tuple[GitHubOAuthClient, Any]:
    """Return (oauth_client, fresh_or_cached_installation_token)."""
    oauth = GitHubOAuthClient()
    cached = _token_cache.get(installation_id)
    if cached is None or cached.expired:
        cached = await oauth.installation_token(installation_id)
        _token_cache[installation_id] = cached
    return oauth, cached


async def _ensure_state_row(org_id: str) -> dict[str, Any]:
    """Insert-if-missing the per-org onboarding_state row, return it."""
    client = await get_postgres_client()
    row = await client.fetchrow(
        "SELECT * FROM onboarding_state WHERE org_id = $1", org_id,
    )
    if row:
        return dict(row)
    await client.execute(
        "INSERT INTO onboarding_state (org_id) VALUES ($1) "
        "ON CONFLICT (org_id) DO NOTHING",
        org_id,
    )
    row = await client.fetchrow(
        "SELECT * FROM onboarding_state WHERE org_id = $1", org_id,
    )
    return dict(row) if row else {"org_id": org_id, "step": "welcome"}


def _state_to_dict(row: dict[str, Any]) -> dict[str, Any]:
    agents = row.get("agents_onboarded") or []
    if isinstance(agents, str):
        agents = json.loads(agents)
    completed = row.get("completed_by_users") or []
    if isinstance(completed, str):
        completed = json.loads(completed)
    updated_at = row.get("updated_at")
    updated_iso = (
        updated_at.isoformat() if isinstance(updated_at, datetime) else str(updated_at or "")
    )
    # LP-11: cat-23 wizard uses ``step``; D.14 v2 uses ``current_step``
    # on the same table depending on which migration landed. Prefer
    # ``step``, then map ``current_step`` so the banner/wizard stay
    # consistent.
    step = row.get("step")
    if not step:
        v2 = row.get("current_step")
        step = _v2_step_to_wizard(str(v2)) if v2 else "welcome"
    return {
        "org_id": str(row.get("org_id", "")),
        "step": step or "welcome",
        "org_setup_choice": row.get("org_setup_choice"),
        "agents_onboarded": list(agents),
        "completed_by_users": [str(u) for u in completed],
        "updated_at": updated_iso,
    }


def _v2_step_to_wizard(current_step: str) -> str:
    """Map D.14 v2 vocabulary onto the 4-step wizard."""
    mapping = {
        "install": "welcome",  # v2 starts at install; wizard at welcome
        "org": "welcome",
        "connect": "connect",
        "wait": "install",
        "done": "done",
        "tour": "done",
        "autonomous": "done",
    }
    return mapping.get(current_step, "welcome")


def _wizard_step_to_v2(step: str) -> str | None:
    """Best-effort reverse map for syncing v2 when cat-23 advances."""
    mapping = {
        "welcome": "install",
        "org_setup": "org",
        "connect": "connect",
        "connect_github": "connect",
        "install": "install",
        "install_sdk": "install",
        "wait": "wait",
        "wait_for_pr": "wait",
        "done": "done",
    }
    return mapping.get(step)


# ── Public integration routes ───────────────────────────────────────


@public_router.get("/configured", response_model=ConfiguredResponse)
async def github_configured() -> ConfiguredResponse:
    """Public — does this Eden instance have a GitHub App wired up?"""
    slug: str | None = None
    if is_configured():
        try:
            slug = GitHubOAuthClient().resolve_app_slug()
        except GitHubConfigError:
            slug = None
    return ConfiguredResponse(
        configured=is_configured(),
        app_slug=slug,
    )


@public_router.get("/authorize", response_model=AuthorizeResponse)
async def github_authorize(
    request: Request,
    org: dict = Depends(require_org_permission_dep("integrations:write")),
) -> AuthorizeResponse:
    """Return the GitHub install URL + a CSRF state token.

    The state token is rotated per call so re-entering the wizard
    doesn't reuse a stale token. The caller persists the state in
    the session (cookie) and the callback verifies it matches.
    """
    if not is_configured():
        raise HTTPException(503, "GitHub App is not configured on this Eden instance.")
    try:
        client = GitHubOAuthClient()
    except GitHubConfigError as exc:
        raise HTTPException(503, str(exc)) from exc
    state = client.new_state_token()
    install_url = client.get_install_url(state=state)
    # Persist state in the session table (light: piggyback on the
    # onboarding_state row so we don't need a new table). Keyed by
    # org_id; overwrites prior pending state.
    pg = await get_postgres_client()
    await pg.execute(
        """
        INSERT INTO onboarding_state (org_id, step, completed_by_users)
        VALUES ($1, 'connect_github', $2::jsonb)
        ON CONFLICT (org_id) DO UPDATE
        SET step = 'connect_github',
            completed_by_users = onboarding_state.completed_by_users,
            updated_at = NOW()
        """,
        org["org_id"],
        json.dumps([{"oauth_state": state}]),
    )
    return AuthorizeResponse(install_url=install_url, state=state)


@public_router.get("/callback")
async def github_callback(
    installation_id: int = Query(...),
    setup_action: str = Query("install"),
    state: str | None = Query(None),
):
    """GitHub redirects the user here after they grant repo access.

    We do NOT call `require_org_permission` here because GitHub
    initiates the request and the user's cookie may not be present
    in some flows. Instead we trust the state token to identify the
    org, persist the installation, and redirect to the wizard.
    """
    if not is_configured():
        raise HTTPException(503, "GitHub App is not configured on this Eden instance.")
    # Resolve the org from the state token if present.
    pg = await get_postgres_client()
    org_id: str | None = None
    if state:
        rows = await pg.fetch(
            """
            SELECT org_id, completed_by_users
            FROM onboarding_state
            WHERE completed_by_users::text LIKE $1
            """,
            f'%"oauth_state": "{state}"%',
        )
        if rows:
            org_id = str(rows[0]["org_id"])
    if not org_id:
        # Couldn't identify org — bounce to the wizard with an error.
        return RedirectResponse(
            url="/onboarding/connect?error=state_not_found",
            status_code=302,
        )
    # Look up the installation account info so we can render a
    # recognisable label in the UI.
    try:
        oauth = GitHubOAuthClient()
        token = await oauth.installation_token(installation_id)
        async_client_resp = await oauth.list_installation_repos(token)
        account_login = (
            async_client_resp[0].owner if async_client_resp else "unknown"
        )
    except GitHubAPIError as exc:
        logger.warning("github_callback installation_token failed: %s", redact_all(str(exc)))
        return RedirectResponse(
            url="/onboarding/connect?error=installation_token_failed",
            status_code=302,
        )
    await pg.execute(
        """
        INSERT INTO org_github_installations
            (org_id, installation_id, github_account_login,
             github_account_type, installed_by_user_id)
        VALUES ($1, $2, $3, 'Organization', NULL)
        ON CONFLICT (org_id, installation_id) DO UPDATE
        SET github_account_login = EXCLUDED.github_account_login,
            suspended_at = NULL
        """,
        org_id,
        int(installation_id),
        account_login,
    )
    return RedirectResponse(
        url=f"/onboarding/connect?installation_id={installation_id}",
        status_code=302,
    )


@public_router.post("/webhook")
async def github_webhook(request: Request) -> dict[str, str]:
    """Receive GitHub webhook events; update PR-run statuses.

    Verifies the X-Hub-Signature-256 header against the configured
    GITHUB_APP_WEBHOOK_SECRET. Currently handles ``pull_request`` events
    (closed / merged) and ``installation`` (suspended / unsuspended).
    """
    secret = getattr(settings, "github_app_webhook_secret", "")
    if not secret:
        raise HTTPException(503, "Webhook secret not configured.")
    body = await request.body()
    sig = request.headers.get("X-Hub-Signature-256", "")
    if not verify_webhook_signature(body=body, signature_header=sig, secret=secret):
        raise HTTPException(401, "Invalid webhook signature.")
    event = request.headers.get("X-GitHub-Event", "")
    payload = json.loads(body) if body else {}
    pg = await get_postgres_client()
    if event == "pull_request":
        pr = payload.get("pull_request", {})
        action = payload.get("action", "")
        pr_number = pr.get("number")
        repo_full = (payload.get("repository") or {}).get("full_name", "")
        if not pr_number or not repo_full:
            return {"status": "ignored"}
        if action == "closed":
            merged = pr.get("merged", False)
            new_status = "merged" if merged else "closed"
            ts_col = "merged_at" if merged else "closed_at"
            await pg.execute(
                f"""
                UPDATE onboarding_pr_runs
                SET status = $1, {ts_col} = NOW()
                WHERE repo_full_name = $2 AND pr_number = $3
                """,
                new_status, repo_full, int(pr_number),
            )
    elif event == "installation":
        action = payload.get("action", "")
        installation_id = (payload.get("installation") or {}).get("id")
        if action == "suspend" and installation_id:
            await pg.execute(
                """
                UPDATE org_github_installations
                SET suspended_at = NOW()
                WHERE installation_id = $1
                """,
                int(installation_id),
            )
        elif action == "unsuspend" and installation_id:
            await pg.execute(
                """
                UPDATE org_github_installations
                SET suspended_at = NULL
                WHERE installation_id = $1
                """,
                int(installation_id),
            )
    return {"status": "ok"}


# ── Org-scoped routes ───────────────────────────────────────────────


@org_router.post("/github/installations/claim", response_model=InstallationOut)
async def claim_github_installation(
    org_id: str,
    req: ClaimInstallationRequest,
    user: dict = Depends(get_current_user),
    org: dict = Depends(require_org_permission_dep("integrations:write")),
) -> InstallationOut:
    """Persist a GitHub App installation after the portal callback.

    ``GITHUB_APP_CALLBACK_URL`` points at the portal
    (``/onboarding/connect``), so GitHub redirects there with
    ``installation_id`` instead of hitting ``/integrations/github/callback``.
    This route lets the wizard register the installation in Eden's DB.
    """
    pg = await get_postgres_client()
    installation_id = int(req.installation_id)
    try:
        oauth = GitHubOAuthClient()
        token = await oauth.installation_token(installation_id)
        repos = await oauth.list_installation_repos(token)
        account_login = repos[0].owner if repos else "unknown"
    except (GitHubConfigError, GitHubAPIError) as exc:
        raise HTTPException(400, f"Could not verify GitHub installation: {exc}") from exc

    row = await pg.fetchrow(
        """
        INSERT INTO org_github_installations
            (org_id, installation_id, github_account_login,
             github_account_type, installed_by_user_id)
        VALUES ($1, $2, $3, 'Organization', $4)
        ON CONFLICT (org_id, installation_id) DO UPDATE
        SET github_account_login = EXCLUDED.github_account_login,
            suspended_at = NULL
        RETURNING installation_id, github_account_login, github_account_type,
                  installed_at, suspended_at
        """,
        org_id,
        installation_id,
        account_login,
        user["user_id"],
    )
    if not row:
        raise HTTPException(500, "Failed to persist GitHub installation")
    return InstallationOut(
        installation_id=int(row["installation_id"]),
        account_login=row["github_account_login"],
        account_type=row["github_account_type"],
        installed_at=row["installed_at"].isoformat(),
        suspended=bool(row["suspended_at"]),
    )


@org_router.get("/github/installations", response_model=list[InstallationOut])
async def list_org_installations(
    org_id: str,
    org: dict = Depends(require_org_member),
) -> list[InstallationOut]:
    pg = await get_postgres_client()
    rows = await pg.fetch(
        """
        SELECT installation_id, github_account_login, github_account_type,
               installed_at, suspended_at
        FROM org_github_installations
        WHERE org_id = $1
        ORDER BY installed_at DESC
        """,
        org_id,
    )
    return [
        InstallationOut(
            installation_id=int(r["installation_id"]),
            account_login=r["github_account_login"],
            account_type=r["github_account_type"],
            installed_at=r["installed_at"].isoformat(),
            suspended=bool(r["suspended_at"]),
        )
        for r in rows
    ]


@org_router.get("/github/repos", response_model=list[RepoOut])
async def list_org_repos(
    org_id: str,
    org: dict = Depends(require_org_permission_dep("integrations:write")),
) -> list[RepoOut]:
    """List repos all the org's installations have access to.

    Admin-only (`integrations:write`). Member/viewer roles see the
    sidebar entry but the page tells them to ask an admin.
    """
    pg = await get_postgres_client()
    inst_rows = await pg.fetch(
        """
        SELECT installation_id FROM org_github_installations
        WHERE org_id = $1 AND suspended_at IS NULL
        """,
        org_id,
    )
    out: list[RepoOut] = []
    for r in inst_rows:
        installation_id = int(r["installation_id"])
        try:
            _, token = await _client_for(installation_id)
            repos = await GitHubOAuthClient().list_installation_repos(token)
        except (GitHubConfigError, GitHubAPIError) as exc:
            logger.warning("list_org_repos installation %s: %s", installation_id, redact_all(str(exc)))
            continue
        for repo in repos:
            out.append(RepoOut(
                full_name=repo.full_name,
                name=repo.name,
                owner=repo.owner,
                default_branch=repo.default_branch,
                private=repo.private,
                description=repo.description or "",
                html_url=repo.html_url,
                installation_id=installation_id,
            ))
    return out


@org_router.post("/github/integrate", response_model=PRRunOut)
async def integrate_repo(
    org_id: str,
    req: IntegrateRequest,
    user: dict = Depends(get_current_user),
    org: dict = Depends(require_org_permission_dep("integrations:write")),
) -> PRRunOut:
    """Detect the framework + open the integration PR.

    Returns the new ``onboarding_pr_runs`` row. The wizard polls
    ``GET /orgs/{org_id}/onboarding/pr-runs`` for status changes.
    """
    pg = await get_postgres_client()
    # Idempotency: if there's already an OPEN run for this (org, agent,
    # repo) triple, return it instead of opening a duplicate PR.
    existing = await pg.fetchrow(
        """
        SELECT * FROM onboarding_pr_runs
        WHERE org_id = $1
          AND repo_full_name = $2
          AND COALESCE(agent_id, '') = COALESCE($3, '')
          AND status IN ('pending', 'opened')
        ORDER BY created_at DESC
        LIMIT 1
        """,
        org_id, req.repo_full_name, req.agent_id,
    )
    if existing:
        return _row_to_pr_run_out(dict(existing))
    # Insert pending row up-front so the wizard can see "in progress".
    run_row = await pg.fetchrow(
        """
        INSERT INTO onboarding_pr_runs
            (org_id, agent_id, installation_id, repo_full_name,
             status, opened_by_user_id)
        VALUES ($1, $2, $3, $4, 'pending', $5)
        RETURNING *
        """,
        org_id, req.agent_id, int(req.installation_id),
        req.repo_full_name, user["user_id"],
    )
    run_id = str(run_row["id"])
    # Mint a token + run detection.
    try:
        _, token = await _client_for(req.installation_id)
        repo_provider = GitHubRepoProvider(token=token.token, repo=req.repo_full_name)
        default_branch = await repo_provider.get_default_branch()
        detection, plan = await build_integration_for_repo(
            repo_provider, org_id=org_id,
        )
        # Build the file changes for the PR.
        files = [
            FileEntry(path=c.path, size=len(c.content), content=c.content)
            for c in plan.changes
        ]
        pr_provider = GitHubPRProvider(token=token.token, repo=req.repo_full_name)
        agent_label = req.agent_name or req.agent_id or "your agent"
        branch = f"eden/onboarding-{int(datetime.now(UTC).timestamp())}"
        pr = await pr_provider.create_pr(PRCreateRequest(
            title=f"[Eden] Auto-instrument {agent_label}",
            body=_format_pr_body(detection, plan, agent_label),
            branch=branch,
            base=default_branch,
            files=files,
            labels=["eden", "onboarding"],
            commit_message=f"eden: auto-instrument {agent_label}",
        ))
        await pg.execute(
            """
            UPDATE onboarding_pr_runs
            SET status = 'opened',
                framework = $1,
                language = $2,
                branch = $3,
                pr_number = $4,
                pr_url = $5,
                detail = $6::jsonb,
                opened_at = NOW()
            WHERE id = $7
            """,
            detection.framework,
            detection.language,
            branch,
            pr.number,
            pr.url,
            json.dumps({
                "detection": detection.to_dict(),
                "plan": plan.to_dict(),
            }),
            run_id,
        )
    except (GitHubAPIError, GitHubConfigError) as exc:
        logger.warning("integrate_repo GitHub error: %s", redact_all(str(exc)))
        await pg.execute(
            """
            UPDATE onboarding_pr_runs
            SET status = 'failed',
                detail = $1::jsonb
            WHERE id = $2
            """,
            json.dumps({"error": str(exc)}),
            run_id,
        )
    except Exception as exc:  # noqa: BLE001 — wide on purpose, last-resort
        logger.exception("integrate_repo unexpected error: %s", redact_all(str(exc)))
        await pg.execute(
            """
            UPDATE onboarding_pr_runs
            SET status = 'failed',
                detail = $1::jsonb
            WHERE id = $2
            """,
            json.dumps({"error": "unexpected", "message": str(exc)}),
            run_id,
        )
    fresh = await pg.fetchrow(
        "SELECT * FROM onboarding_pr_runs WHERE id = $1", run_id,
    )
    return _row_to_pr_run_out(dict(fresh) if fresh else {})


@org_router.get("/onboarding/pr-runs", response_model=list[PRRunOut])
async def list_onboarding_pr_runs(
    org_id: str,
    limit: int = Query(50, ge=1, le=200),
    org: dict = Depends(require_org_member),
) -> list[PRRunOut]:
    pg = await get_postgres_client()
    rows = await pg.fetch(
        """
        SELECT * FROM onboarding_pr_runs
        WHERE org_id = $1
        ORDER BY created_at DESC
        LIMIT $2
        """,
        org_id, limit,
    )
    return [_row_to_pr_run_out(dict(r)) for r in rows]


@org_router.get("/onboarding/state", response_model=OnboardingStateOut)
async def get_onboarding_state(
    org_id: str,
    org: dict = Depends(require_org_member),
) -> OnboardingStateOut:
    row = await _ensure_state_row(org_id)
    return OnboardingStateOut(**_state_to_dict(row))


@org_router.post("/onboarding/state", response_model=OnboardingStateOut)
async def patch_onboarding_state(
    org_id: str,
    patch: OnboardingStatePatch,
    user: dict = Depends(get_current_user),
    org: dict = Depends(require_org_member),
) -> OnboardingStateOut:
    pg = await get_postgres_client()
    existing = await _ensure_state_row(org_id)
    new_step = patch.step or existing.get("step") or "welcome"
    new_choice = patch.org_setup_choice or existing.get("org_setup_choice")
    agents = existing.get("agents_onboarded") or []
    if isinstance(agents, str):
        agents = json.loads(agents)
    if patch.mark_agent_onboarded:
        agents = list(agents) + [patch.mark_agent_onboarded]
    completed = existing.get("completed_by_users") or []
    if isinstance(completed, str):
        completed = json.loads(completed)
    # Track which users have completed; the wizard uses this to know
    # whether to show "Welcome back" vs "Resume onboarding".
    user_id = str(user["user_id"])
    if new_step == "done" and user_id not in [str(u) for u in completed]:
        completed = list(completed) + [user_id]
    await pg.execute(
        """
        UPDATE onboarding_state
        SET step = $1,
            org_setup_choice = $2,
            agents_onboarded = $3::jsonb,
            completed_by_users = $4::jsonb,
            updated_at = NOW()
        WHERE org_id = $5
        """,
        new_step,
        new_choice,
        json.dumps(agents),
        json.dumps(completed),
        org_id,
    )
    # LP-11: best-effort sync of D.14 ``current_step`` when the column
    # exists (056 schema). Ignore failures on legacy ``step``-only DBs.
    v2_step = _wizard_step_to_v2(new_step)
    if v2_step:
        try:
            await pg.execute(
                """
                UPDATE onboarding_state
                SET current_step = $1, updated_at = NOW()
                WHERE org_id = $2
                """,
                v2_step,
                org_id,
            )
        except Exception:
            logger.debug(
                "onboarding: current_step sync skipped for org=%s", org_id, exc_info=True,
            )
    row = await pg.fetchrow(
        "SELECT * FROM onboarding_state WHERE org_id = $1", org_id,
    )
    return OnboardingStateOut(**_state_to_dict(dict(row) if row else {}))


# ── Internal ───────────────────────────────────────────────────────


def _row_to_pr_run_out(row: dict[str, Any]) -> PRRunOut:
    def _iso(v: Any) -> str | None:
        return v.isoformat() if isinstance(v, datetime) else (str(v) if v else None)
    detail = row.get("detail") or {}
    if isinstance(detail, str):
        detail = json.loads(detail)
    return PRRunOut(
        id=str(row.get("id", "")),
        org_id=str(row.get("org_id", "")),
        agent_id=row.get("agent_id"),
        repo_full_name=row.get("repo_full_name") or "",
        framework=row.get("framework"),
        language=row.get("language"),
        branch=row.get("branch"),
        pr_number=row.get("pr_number"),
        pr_url=row.get("pr_url"),
        status=row.get("status") or "pending",
        detail=detail,
        created_at=_iso(row.get("created_at")) or "",
        opened_at=_iso(row.get("opened_at")),
        merged_at=_iso(row.get("merged_at")),
        closed_at=_iso(row.get("closed_at")),
    )


def _format_pr_body(detection: Any, plan: Any, agent_label: str) -> str:
    """Render a human-friendly PR description."""
    lines: list[str] = [
        "## 🌱 Eden auto-instrumentation",
        "",
        f"Wires `{agent_label}` into Eden so every run streams traces, "
        "costs, judge scores, and replay data to your dashboard.",
        "",
        f"**Detected framework:** `{detection.framework}` "
        f"(`{detection.language}`, confidence {detection.confidence:.2f})",
        "",
        "### File changes",
        "",
    ]
    for ch in plan.changes:
        lines.append(f"- **{ch.path}** — {ch.description}")
    if plan.notes:
        lines.append("")
        lines.append("### Notes")
        for note in plan.notes:
            lines.append(f"- {note}")
    lines.extend([
        "",
        "### What to do",
        "",
        "1. Set `EDEN_API_KEY` + `EDEN_DEFAULT_ORG` in your deploy env.",
        "2. Merge this PR.",
        "3. Open your portal at `/traces` — traces should appear within a minute.",
        "",
        "_Generated by the Eden onboarding wizard. Safe to edit or close._",
    ])
    return "\n".join(lines)


# ────────────────────────────────────────────────────────────────────
# Cat 23 audit (2026-06-21): the "send sample request" activation
# step was a no-op because no endpoint existed. This route fires a
# tiny LLM call through the existing gateway and returns a trace_id
# the wizard polls for. Always returns 200 with a synthetic
# ``trace_id`` so the UI can advance even if the upstream call fails
# (no API key, network blip) — the failure is surfaced as
# ``llm_ok=False`` rather than a hard 5xx that breaks the wizard.


class SampleRequestResponse(BaseModel):
    trace_id: str
    llm_ok: bool
    detail: str = ""


@org_router.post(
    "/onboarding/sample-request",
    response_model=SampleRequestResponse,
)
async def onboarding_sample_request(
    org_id: str,
    org: dict = Depends(require_org_member),
) -> SampleRequestResponse:
    """Fire a small test prompt through the gateway.

    Used by the onboarding wizard's activation step. Trace ID is
    generated locally (``onb_<uuid>`` prefix) so the wizard can
    poll ``/observability/traces/{trace_id}`` and check whether
    the call landed. The LLM call is best-effort; the wizard
    advances either way.
    """
    trace_id = f"onb_{uuid.uuid4().hex[:16]}"
    try:
        from eden.llm.client import OpenRouterClient

        client = OpenRouterClient()
        # Tiny prompt, cheapest reasonable model. Errors are
        # swallowed — we want the trace_id to come back regardless.
        client.call(
            agent="eden_onboarding_smoke",
            prompt="Reply with the single word: ok",
            slot="fast",
            system_prompt="You are a smoke-test responder. Always reply with one word.",
            max_tokens=8,
        )
        return SampleRequestResponse(
            trace_id=trace_id, llm_ok=True, detail="sample request sent"
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("onboarding_sample_request: LLM call failed: %s", redact_all(str(exc)))
        return SampleRequestResponse(
            trace_id=trace_id,
            llm_ok=False,
            detail=f"smoke call failed (non-blocking): {exc}",
        )
