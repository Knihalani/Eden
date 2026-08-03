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
* ``POST /orgs/{org_id}/github/repos/connect``
    Owner/admin — upsert ``repo_connections`` for the linked repo
    (installation_id, repo_full_name, default_branch, status=active).
* ``POST /orgs/{org_id}/github/integrate``
    Retired — returns 410. Manual SDK install replaces auto-PR.
* ``GET  /orgs/{org_id}/onboarding/state``
    Member — fetch the org's wizard state.
* ``POST /orgs/{org_id}/onboarding/state``
    Member — patch the wizard state (advance, mark agent_setup_choice).
* ``GET  /orgs/{org_id}/onboarding/pr-runs``
    Member — list historical integration PR runs (read-only).

RBAC: the `integrations:write` permission gates the write-side routes
(``authorize``, ``claim``). The repo list + state-read routes are
member-level, but the wizard hides them client-side from
member/viewer roles so they only see the "ask your admin" callout.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator
from starlette.responses import RedirectResponse

from eden.api.deps import (
    get_current_user,
    require_org_member,
    require_org_permission_dep,
    require_path_org_access,
    resolve_eden_org_id,
    resolve_eden_user_id,
)
from eden.api.utils.redact import redact_all
from eden.config import get_settings
from eden.integrations.github import (
    GitHubAPIError,
    GitHubConfigError,
    GitHubOAuthClient,
    is_configured,
    verify_webhook_signature,
)
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

#: Shape of a legitimate oauth ``state`` token.
#:
#: These are minted with ``secrets.token_urlsafe``, whose alphabet is
#: ``[A-Za-z0-9_-]``. Anything else on the unauthenticated GitHub
#: callback is not a token we issued, so it is refused before it reaches
#: a query at all — defence in depth behind the wildcard fix below.
_SAFE_STATE_RE = re.compile(r"[A-Za-z0-9_\-]{16,128}")
settings = get_settings()

# Two routers — one for the public integration surface, one for the
# per-org surface. Both registered in app.py.
public_router = APIRouter(prefix="/integrations/github", tags=["integrations"])
org_router = APIRouter(
    prefix="/orgs/{org_id}",
    tags=["onboarding"],
    dependencies=[Depends(require_path_org_access)],
)

# Installation tokens are minted on demand. Cache for the token's
# lifetime so we don't hammer the GitHub App JWT endpoint.
_token_cache: dict[int, Any] = {}

# Per-installation repo list cache: installation_id → (expires_monotonic, repos)
_repos_cache: dict[int, tuple[float, list[Any]]] = {}
_REPOS_CACHE_TTL_S = 60.0

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
    #: Repository Contents permission on the App registration
    #: (``read`` / ``write`` / ``none``). PR creation needs ``write``.
    contents_permission: str | None = None
    #: True when the App can create branches/blobs/commits for fix PRs.
    can_open_prs: bool = False


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


class ClaimInstallationRequest(BaseModel):
    installation_id: int

    @field_validator("installation_id", mode="before")
    @classmethod
    def _coerce_installation_id(cls, v: object) -> object:
        if v is None or v == "":
            raise ValueError("installation_id is required")
        if isinstance(v, str) and not v.strip().isdigit():
            raise ValueError("installation_id must be a positive integer")
        return int(v)

    @field_validator("installation_id")
    @classmethod
    def _positive_installation_id(cls, v: int) -> int:
        if v <= 0:
            raise ValueError("installation_id must be a positive integer")
        return v


class ConnectRepoRequest(BaseModel):
    installation_id: int
    repo_full_name: str
    # Empty means "resolve from GitHub at connect time" — do not invent main.
    default_branch: str = ""
    # Per-agent link: one active repo per agent. Required for new connects
    # from the Agents UI; omit only for legacy org-wide links.
    agent_id: str | None = None

    @field_validator("installation_id", mode="before")
    @classmethod
    def _coerce_installation_id(cls, v: object) -> object:
        if v is None or v == "":
            raise ValueError("installation_id is required")
        if isinstance(v, str) and not v.strip().isdigit():
            raise ValueError("installation_id must be a positive integer")
        return int(v)

    @field_validator("installation_id")
    @classmethod
    def _positive_installation_id(cls, v: int) -> int:
        if v <= 0:
            raise ValueError("installation_id must be a positive integer")
        return v

    @field_validator("repo_full_name")
    @classmethod
    def _valid_repo_full_name(cls, v: str) -> str:
        name = (v or "").strip()
        if not name or "/" not in name or name.count("/") != 1:
            raise ValueError("repo_full_name must be owner/repo")
        owner, repo = name.split("/", 1)
        if not owner or not repo:
            raise ValueError("repo_full_name must be owner/repo")
        return name

    @field_validator("default_branch")
    @classmethod
    def _normalize_default_branch(cls, v: str) -> str:
        branch = (v or "").strip()
        if len(branch) > 128:
            raise ValueError("default_branch is too long")
        return branch

    @field_validator("agent_id", mode="before")
    @classmethod
    def _normalize_agent_id(cls, v: object) -> str | None:
        if v is None:
            return None
        s = str(v).strip()
        return s or None


class RepoConnectionOut(BaseModel):
    id: str
    org_id: str
    provider: str
    installation_id: str
    repo_full_name: str
    default_branch: str
    status: str
    agent_id: str | None = None


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


def _installed_at_iso(value: Any) -> str:
    """Normalize PG timestamptz / already-string values for InstallationOut."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    iso = getattr(value, "isoformat", None)
    if callable(iso):
        return str(iso())
    return str(value)


async def _eden_org_or_404(org_id: str) -> str:
    """Map Clerk or Eden org id to canonical ``organizations.id``."""
    eden_org_id = await resolve_eden_org_id(org_id)
    if not eden_org_id:
        raise HTTPException(404, "Organization not found")
    return eden_org_id


async def _persist_installation_row(
    pg: Any,
    *,
    org_id: str,
    installation_id: int,
    account_login: str,
    account_type: str = "Organization",
    installed_by_user_id: str | None = None,
) -> dict[str, Any]:
    row = await pg.fetchrow(
        """
        INSERT INTO org_github_installations
            (org_id, installation_id, github_account_login,
             github_account_type, installed_by_user_id)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (org_id, installation_id) DO UPDATE
        SET github_account_login = EXCLUDED.github_account_login,
            suspended_at = NULL
        RETURNING installation_id, github_account_login, github_account_type,
                  installed_at, suspended_at
        """,
        org_id,
        installation_id,
        account_login,
        account_type,
        installed_by_user_id,
    )
    if not row:
        raise HTTPException(500, "Failed to persist GitHub installation")
    return dict(row)


async def _guess_org_for_github_install(pg: Any) -> str | None:
    """Deprecated: never auto-bind installations across tenants.

    ``installation.created`` must not pick ``ORDER BY updated_at`` from
    *any* org's onboarding_state — that races and can attach a GitHub
    App install to the wrong tenant. Portal ``claim_github_installation``
    is the only safe bind path (authenticated org member + installation_id).
    """
    del pg  # unused — kept for call-site compatibility during rollout
    return None


# Kept name for tests that patch the symbol; always returns None.


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
        "SELECT * FROM onboarding_state WHERE org_id = $1",
        org_id,
    )
    if row:
        return dict(row)
    await client.execute(
        "INSERT INTO onboarding_state (org_id) VALUES ($1) " "ON CONFLICT (org_id) DO NOTHING",
        org_id,
    )
    row = await client.fetchrow(
        "SELECT * FROM onboarding_state WHERE org_id = $1",
        org_id,
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


async def _enqueue_change_impact_preview(
    pg: Any,
    payload: dict[str, Any],
    repo_full: str,
    pr: dict[str, Any] | None = None,
) -> None:
    """N04: run change impact preview on PR open/sync (best-effort)."""
    try:
        from eden.config import get_settings

        if not getattr(get_settings(), "change_impact_preview_v1", False):
            return
    except Exception:
        return
    pr = pr or payload.get("pull_request") or {}
    pr_number = pr.get("number")
    head = (pr.get("head") or {}).get("sha", "")
    if not pr_number:
        return

    row = await pg.fetchrow(
        """
        SELECT org_id, installation_id FROM onboarding_pr_runs
        WHERE repo_full_name = $1
        ORDER BY created_at DESC
        LIMIT 1
        """,
        repo_full,
    )
    org_id = str(row["org_id"]) if row and row.get("org_id") else "default"
    installation_id = int(row["installation_id"]) if row and row.get("installation_id") else None

    # pull_request webhooks are not push-shaped — do not read payload["commits"].
    changed = await _pr_changed_filenames(
        installation_id=installation_id,
        repo_full=repo_full,
        pr_number=int(pr_number),
    )
    from eden.change_impact.preview import ChangeDetector, ImpactPreviewOrchestrator

    agent_files = ChangeDetector.detect_changed_files(changed)
    if not agent_files:
        return

    prompt_override = await _pr_prompt_override(
        installation_id=installation_id,
        repo_full=repo_full,
        head_sha=str(head or ""),
        agent_files=agent_files,
    )
    change_id = f"pr-{repo_full}-{pr_number}"
    orchestrator = ImpactPreviewOrchestrator(pg=pg)
    report = await orchestrator.generate_report(
        org_id,
        change_id=change_id,
        changed_files=agent_files,
        agent_id=ChangeDetector.resolve_agent_id(agent_files),
        prompt_override=prompt_override,
    )
    try:
        from eden.evaluation.ci_webhook import CIWebhookHandler

        await CIWebhookHandler().on_prompt_change(
            org_id,
            changed_files=agent_files,
            change_id=change_id,
            agent_id=ChangeDetector.resolve_agent_id(agent_files),
        )
    except Exception as exc:
        logger.debug("N01 CI webhook on PR failed: %s", redact_all(str(exc)))
    logger.info(
        "change_impact_preview org=%s change=%s recommendation=%s head=%s",
        org_id,
        change_id,
        report.recommendation,
        head[:12] if head else "",
    )
    if installation_id and pr_number and head:
        from eden.change_impact.preview import post_github_check_and_comment

        gh_result = await post_github_check_and_comment(
            installation_id=installation_id,
            repo_full=repo_full,
            pr_number=int(pr_number),
            head_sha=head,
            report=report,
        )
        logger.info(
            "change_impact_github org=%s pr=%s posted=%s",
            org_id,
            pr_number,
            gh_result.get("posted") or gh_result.get("skipped"),
        )


async def _pr_changed_filenames(
    *,
    installation_id: int | None,
    repo_full: str,
    pr_number: int,
) -> list[str]:
    """Resolve PR changed paths via GitHub pulls/.../files API."""
    if not installation_id:
        return []
    parts = repo_full.split("/", 1)
    if len(parts) != 2:
        return []
    owner, repo = parts[0], parts[1]
    try:
        from eden.integrations.github import GitHubOAuthClient, is_configured

        if not is_configured():
            return []
        oauth = GitHubOAuthClient()
        token = await oauth.installation_token(installation_id)
        return await oauth.list_pull_request_files(
            token, owner=owner, repo=repo, pr_number=pr_number
        )
    except Exception as exc:
        logger.debug(
            "change_impact pr files fetch failed repo=%s pr=%s: %s",
            repo_full,
            pr_number,
            redact_all(str(exc)),
        )
        return []


async def _pr_prompt_override(
    *,
    installation_id: int | None,
    repo_full: str,
    head_sha: str,
    agent_files: list[str],
) -> str | None:
    """Load first prompt/config file content at PR head for replay override."""
    if not installation_id or not head_sha or not agent_files:
        return None
    parts = repo_full.split("/", 1)
    if len(parts) != 2:
        return None
    owner, repo = parts[0], parts[1]
    target = next(
        (p for p in agent_files if p.startswith("prompts/") or "prompt" in p.lower()),
        agent_files[0],
    )
    try:
        from eden.integrations.github import GitHubOAuthClient, is_configured

        if not is_configured():
            return None
        oauth = GitHubOAuthClient()
        token = await oauth.installation_token(installation_id)
        content = await oauth.get_file_at_ref(
            token, owner=owner, repo=repo, path=target, ref=head_sha
        )
        if content and content.strip():
            return content.strip()
    except Exception as exc:
        logger.debug(
            "change_impact prompt fetch failed path=%s: %s",
            target,
            redact_all(str(exc)),
        )
    return None


async def _sync_improvement_plan_on_pr_close(
    *,
    repo_full: str,
    pr_number: int,
    merged: bool,
) -> None:
    """N23/N20 (Phase 2b): sync improvement_plans status on PR close.

    ``approve.approve_plan`` opens the PR and leaves the plan at
    ``pr_opened`` — this webhook is the only signal that a human
    actually merged/closed it on GitHub, so the Improve inbox isn't
    stuck showing a stale "PR opened" card forever. On merge, reuses
    the approve flow's existing N01 regression-verify scheduling
    (:func:`eden.improvement.approve.queue_verify_for_plan`) instead of
    inventing a second verify subsystem.

    Best-effort: any failure here must not break the webhook response
    (GitHub retries on non-2xx, and this is a secondary side-effect of
    the primary ``onboarding_pr_runs`` update above).
    """
    try:
        from eden.improvement import plans_repo
        from eden.improvement.approve import queue_verify_for_plan

        plan = await plans_repo.find_by_pr(
            repo_full_name=repo_full,
            pr_number=pr_number,
        )
        if plan is None:
            return
        plan_org_id = str(plan["org_id"])
        plan_id = str(plan["id"])
        if merged:
            updated = await plans_repo.mark_merged(plan_org_id, plan_id)
            await queue_verify_for_plan(
                plan_org_id,
                updated or plan,
                branch=plan.get("github_branch"),
            )
        else:
            await plans_repo.mark_closed(
                plan_org_id,
                plan_id,
                reason="pr_closed_without_merge",
            )
    except Exception as exc:
        logger.warning(
            "github webhook: improvement_plans PR-close sync failed " "repo=%s pr=%s merged=%s: %s",
            repo_full,
            pr_number,
            merged,
            redact_all(str(exc)),
        )


# ── Public integration routes ───────────────────────────────────────


@public_router.get("/configured", response_model=ConfiguredResponse)
async def github_configured() -> ConfiguredResponse:
    """Public — does this Eden instance have a GitHub App wired up?"""
    slug: str | None = None
    contents_permission: str | None = None
    can_open_prs = False
    if is_configured():
        try:
            client = GitHubOAuthClient()
            slug = client.resolve_app_slug()
            try:
                perms = await client.app_permissions()
                contents_permission = str(perms.get("contents") or "none")
                # pull_requests:write opens the PR; contents:write pushes commits.
                can_open_prs = (
                    contents_permission == "write"
                    and str(perms.get("pull_requests") or "") == "write"
                )
            except Exception as exc:  # noqa: BLE001 — best-effort metadata
                logger.debug("github_configured: app_permissions failed: %s", redact_all(str(exc)))
        except GitHubConfigError:
            slug = None
    return ConfiguredResponse(
        configured=is_configured(),
        app_slug=slug,
        contents_permission=contents_permission,
        can_open_prs=can_open_prs,
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
    # org_id; overwrites prior pending oauth_state while preserving
    # real completed-by user id strings (used when step=done).
    pg = await get_postgres_client()
    existing = await pg.fetchrow(
        "SELECT completed_by_users FROM onboarding_state WHERE org_id = $1",
        org["org_id"],
    )
    completed: list[Any] = []
    if existing:
        raw = existing.get("completed_by_users") or []
        if isinstance(raw, str):
            raw = json.loads(raw)
        completed = list(raw)
    merged: list[Any] = [
        entry for entry in completed if not (isinstance(entry, dict) and "oauth_state" in entry)
    ]
    merged.append({"oauth_state": state})
    await pg.execute(
        """
        INSERT INTO onboarding_state (org_id, step, completed_by_users)
        VALUES ($1, 'connect_github', $2::jsonb)
        ON CONFLICT (org_id) DO UPDATE
        SET step = 'connect_github',
            completed_by_users = $2::jsonb,
            updated_at = NOW()
        """,
        org["org_id"],
        json.dumps(merged),
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
        # SECURITY: this endpoint is deliberately UNAUTHENTICATED (GitHub
        # redirects the user here), so ``state`` is fully attacker
        # controlled and is the only thing identifying the org.
        #
        # It was matched with
        #     WHERE completed_by_users::text LIKE $1
        # against f'%"oauth_state": "{state}"%'. In a LIKE pattern ``%``
        # and ``_`` are wildcards, so ``?state=%`` matched EVERY org with
        # a pending oauth_state; with no ORDER BY / LIMIT, ``rows[0]``
        # was an arbitrary victim org, and the installation was then
        # bound to it with no ownership re-check. An attacker could
        # attach their own GitHub App installation to someone else's
        # organisation.
        #
        # Even benign tokens matched loosely: secrets.token_urlsafe
        # emits ``_``, which is a single-character LIKE wildcard.
        #
        # Two changes: ``strpos`` does a literal substring search with no
        # wildcard semantics at all, and an ambiguous match (more than
        # one org) is refused rather than silently resolved to the first.
        if not _SAFE_STATE_RE.fullmatch(state):
            return RedirectResponse(
                url="/agents/connect?error=state_not_found",
                status_code=302,
            )
        rows = await pg.fetch(
            """
            SELECT org_id, completed_by_users
            FROM onboarding_state
            WHERE strpos(completed_by_users::text, $1) > 0
            LIMIT 2
            """,
            f'"oauth_state": "{state}"',
        )
        if len(rows) == 1:
            org_id = str(rows[0]["org_id"])
        elif len(rows) > 1:
            logger.warning(
                "github callback: state matched %d orgs; refusing to guess",
                len(rows),
            )
    if not org_id:
        # Couldn't identify org — bounce to the wizard with an error.
        return RedirectResponse(
            url="/agents/connect?error=state_not_found",
            status_code=302,
        )
    eden_org_id = await _eden_org_or_404(org_id)
    # Look up the installation account info so we can render a
    # recognisable label in the UI.
    try:
        oauth = GitHubOAuthClient()
        token = await oauth.installation_token(installation_id)
        async_client_resp = await oauth.list_installation_repos(token)
        account_login = async_client_resp[0].owner if async_client_resp else "unknown"
    except GitHubAPIError as exc:
        logger.warning("github_callback installation_token failed: %s", redact_all(str(exc)))
        return RedirectResponse(
            url="/agents/connect?error=installation_token_failed",
            status_code=302,
        )
    await _persist_installation_row(
        pg,
        org_id=eden_org_id,
        installation_id=int(installation_id),
        account_login=account_login,
        installed_by_user_id=None,
    )
    return RedirectResponse(
        url=f"/agents/connect?installation_id={installation_id}",
        status_code=302,
    )


@public_router.post("/webhook")
async def github_webhook(request: Request) -> dict[str, str]:
    """Receive GitHub webhook events; update PR-run statuses.

    Verifies the X-Hub-Signature-256 header against the configured
    GITHUB_APP_WEBHOOK_SECRET. Handles ``pull_request`` events
    (closed / merged), ``installation`` (created / deleted / suspended /
    unsuspended). Dedupes on ``X-GitHub-Delivery`` via Redis SET NX.
    """
    secret = getattr(settings, "github_app_webhook_secret", "")
    if not secret:
        raise HTTPException(503, "Webhook secret not configured.")
    body = await request.body()
    sig = request.headers.get("X-Hub-Signature-256", "")
    if not verify_webhook_signature(body=body, signature_header=sig, secret=secret):
        raise HTTPException(401, "Invalid webhook signature.")

    delivery_id = request.headers.get("X-GitHub-Delivery") or ""
    if delivery_id and not await _claim_github_delivery(delivery_id):
        return {"status": "ok", "duplicate": "true"}

    event = request.headers.get("X-GitHub-Event", "")
    payload = json.loads(body) if body else {}
    pg = await get_postgres_client()
    try:
        if event == "pull_request":
            pr = payload.get("pull_request", {})
            action = payload.get("action", "")
            pr_number = pr.get("number")
            repo_full = (payload.get("repository") or {}).get("full_name", "")
            if not pr_number or not repo_full:
                return {"status": "ignored"}
            if action in ("opened", "synchronize", "reopened"):
                await _enqueue_change_impact_preview(pg, payload, repo_full, pr)
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
                    new_status,
                    repo_full,
                    int(pr_number),
                )
                await _sync_improvement_plan_on_pr_close(
                    repo_full=repo_full,
                    pr_number=int(pr_number),
                    merged=merged,
                )
        elif event == "installation":
            action = payload.get("action", "")
            installation = payload.get("installation") or {}
            installation_id = installation.get("id")
            if action == "created" and installation_id:
                account = installation.get("account") or {}
                account_login = account.get("login") or "unknown"
                account_type = (
                    "Organization" if (account.get("type") or "").lower() == "organization" else "User"
                )
                target_org = await _guess_org_for_github_install(pg)
                if target_org:
                    try:
                        await _persist_installation_row(
                            pg,
                            org_id=target_org,
                            installation_id=int(installation_id),
                            account_login=account_login,
                            account_type=account_type,
                            installed_by_user_id=None,
                        )
                    except Exception as exc:
                        logger.warning(
                            "installation.created webhook persist failed: %s",
                            redact_all(str(exc)),
                        )
                else:
                    logger.info(
                        "installation.created id=%s account=%s — awaiting "
                        "authenticated portal claim (no cross-tenant auto-bind)",
                        installation_id,
                        account_login,
                    )
            elif action == "deleted" and installation_id:
                # Schema has no deleted_at — suspended_at is the inactive
                # marker (queries filter WHERE suspended_at IS NULL).
                await pg.execute(
                    """
                    UPDATE org_github_installations
                    SET suspended_at = NOW()
                    WHERE installation_id = $1
                    """,
                    int(installation_id),
                )
            elif action == "suspend" and installation_id:
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
        elif event == "installation_repositories":
            # Repo add/remove under an existing install — no Eden table
            # tracks the full GitHub repo list; suspend/delete of the
            # install itself is handled on ``installation`` events.
            action = payload.get("action", "")
            logger.info(
                "installation_repositories action=%s ignored (no local repo roster)",
                action,
            )
        elif event in ("check_run", "check_suite"):
            # M9 (§4.3): customer CI ingestion for eden/improve-* PRs.
            return await _ingest_check_conclusion(event, payload)
    except Exception:
        if delivery_id:
            await _release_github_delivery(delivery_id)
        raise
    return {"status": "ok"}


_GITHUB_DELIVERY_TTL_S = 86400


async def _claim_github_delivery(delivery_id: str) -> bool:
    """Claim X-GitHub-Delivery. Return False if already processed."""
    try:
        from eden.storage.redis import get_redis_client

        redis = await get_redis_client()
        if redis is None:
            return True
        was_set = await redis.set(
            f"github:delivery:{delivery_id}",
            "1",
            nx=True,
            ex=_GITHUB_DELIVERY_TTL_S,
        )
        return bool(was_set)
    except Exception as exc:  # noqa: BLE001
        logger.debug("github delivery idempotency claim failed: %s", exc)
        return True


async def _release_github_delivery(delivery_id: str) -> None:
    try:
        from eden.storage.redis import get_redis_client

        redis = await get_redis_client()
        if redis is None:
            return
        await redis.delete(f"github:delivery:{delivery_id}")
    except Exception as exc:  # noqa: BLE001
        logger.debug("github delivery idempotency release failed: %s", exc)


# ── M9 (§4.3): customer CI ingestion ────────────────────────────────
# GitHub conclusions that count as "red" for an Eden improvement PR.
# ``neutral``/``skipped``/``stale`` stamp evidence but never notify.
_CI_FAILURE_CONCLUSIONS = frozenset(
    {"failure", "timed_out", "startup_failure", "action_required"}
)


def _plan_linked_paths(plan: dict[str, Any]) -> list[str]:
    """files_changed → plain path list (tolerates str or dict rows)."""
    paths: list[str] = []
    for entry in plan.get("files_changed") or []:
        path = entry.get("path") if isinstance(entry, dict) else entry
        if isinstance(path, str) and path:
            paths.append(path)
    return paths[:8]


def _check_output_excerpt(section: dict[str, Any]) -> str:
    """Short human excerpt from a check_run ``output`` block."""
    output = section.get("output") or {}
    parts = [
        str(output.get(key) or "").strip()
        for key in ("title", "summary")
        if output.get(key)
    ]
    return " — ".join(parts)[:600]


async def _ingest_check_conclusion(event: str, payload: dict[str, Any]) -> dict[str, str]:
    """Ingest a check_run/check_suite conclusion for an Eden PR (§4.3).

    Conclusion events only. Plan resolution: PR number when the payload
    carries one (``find_by_pr``), else the ``eden/improve-*`` head
    branch (``find_by_branch``). Ordering per §10.4: stamp the
    ``ci_status`` evidence FIRST, notify after — re-delivery is safe
    because the outer X-GitHub-Delivery SETNX dedupe short-circuits
    retries and the jsonb evidence merge is idempotent anyway. Red CI
    additionally Slack-notifies (deduped ``ci:{plan}:{check}``) and
    triggers at most ONE cheap regenerate per plan while it is still
    ``pr_opened``.

    Installations that never granted ``checks:read`` simply never
    receive these events — nothing here breaks; the honest
    ``ci_ingestion: "unavailable"`` stamp happens at PR-open
    (``approve._stamp_ci_ingestion_availability``).
    """
    from eden.config import get_settings

    if not bool(getattr(get_settings(), "ci_ingestion_v1", True)):
        return {"status": "ignored", "reason": "ci_ingestion_disabled"}
    if str(payload.get("action") or "") != "completed":
        return {"status": "ignored", "reason": "not_a_conclusion"}
    section = payload.get(event) or {}
    conclusion = str(section.get("conclusion") or "")
    if not conclusion:
        return {"status": "ignored", "reason": "not_a_conclusion"}

    check_name = str(section.get("name") or event)
    suite = section.get("check_suite") if event == "check_run" else section
    head_branch = str(
        (suite or {}).get("head_branch") or section.get("head_branch") or ""
    )
    repo_full = str((payload.get("repository") or {}).get("full_name") or "")

    from eden.improvement import plans_repo

    plan: dict[str, Any] | None = None
    for pr_ref in section.get("pull_requests") or []:
        number = (pr_ref or {}).get("number")
        if number and repo_full:
            plan = await plans_repo.find_by_pr(
                repo_full_name=repo_full, pr_number=int(number)
            )
            if plan is not None:
                break
    if plan is None:
        if not head_branch.startswith("eden/improve-"):
            return {"status": "ignored", "reason": "not_an_eden_branch"}
        plan = await plans_repo.find_by_branch(github_branch=head_branch)
    if plan is None:
        return {"status": "ignored", "reason": "no_matching_plan"}

    org_id = str(plan["org_id"])
    plan_id = str(plan["id"])

    # Stamp BEFORE notify (§10.4) — the durable record must exist even
    # when Slack or the regenerate below fail.
    from eden.improvement.approve import _merge_plan_evidence

    updated = await _merge_plan_evidence(
        org_id,
        plan_id,
        {
            "ci_status": {
                "state": str(section.get("status") or "completed"),
                "conclusion": conclusion,
                "check_name": check_name,
                "updated_at": datetime.now(UTC).isoformat(),
            }
        },
    )
    plan = updated or plan

    if conclusion not in _CI_FAILURE_CONCLUSIONS:
        return {"status": "ok", "ci": "stamped"}

    try:
        from eden.services.slack_notify import notify_ci_failure

        await notify_ci_failure(
            org_id,
            plan_id=plan_id,
            check_name=check_name,
            conclusion=conclusion,
            title=str(plan.get("title") or "Improvement plan"),
            pr_url=(str(plan.get("pr_url") or "").strip() or None),
            agent_id=(str(plan.get("agent_id") or "").strip() or None),
        )
    except Exception as exc:  # noqa: BLE001 — notify must not 500 the hook
        logger.warning(
            "check ingestion: slack notify failed plan=%s: %s",
            plan_id,
            redact_all(str(exc)),
        )

    await _maybe_ci_regenerate(
        org_id,
        plan,
        check_name=check_name,
        excerpt=_check_output_excerpt(section),
    )
    return {"status": "ok", "ci": "stamped"}


async def _maybe_ci_regenerate(
    org_id: str,
    plan: dict[str, Any],
    *,
    check_name: str,
    excerpt: str,
) -> None:
    """At most one cheap CI-driven regenerate per plan (loop guard).

    Reuses the M8/static feedback channel: the CI failure excerpt rides
    in as a ``static_errors`` row, so PatchGenerator sees
    ``- [ci_failure] <check>: <excerpt>``. Only fires while the plan is
    still ``pr_opened``; the attempt is stamped into evidence BEFORE
    generation so a crash mid-generate cannot re-trigger on retry.
    """
    try:
        if str(plan.get("status") or "") != "pr_opened":
            return
        evidence = plan.get("evidence") if isinstance(plan.get("evidence"), dict) else {}
        if (evidence or {}).get("ci_regenerate"):
            return
        from eden.improvement.approve import (
            _merge_plan_evidence,
            regenerate_plan_diff_from_static_errors,
        )

        plan_id = str(plan["id"])
        await _merge_plan_evidence(
            org_id,
            plan_id,
            {
                "ci_regenerate": {
                    "check_name": check_name,
                    "attempted_at": datetime.now(UTC).isoformat(),
                }
            },
        )
        from eden.providers.factory import get_repo_provider_for_org

        provider = await get_repo_provider_for_org(
            org_id, agent_id=(str(plan.get("agent_id") or "").strip() or None)
        )
        result = await regenerate_plan_diff_from_static_errors(
            org_id,
            plan,
            repo_provider=provider,
            static_errors=[
                {
                    "path": check_name,
                    "kind": "ci_failure",
                    "message": excerpt or "customer CI reported a failure",
                }
            ],
            linked_paths=_plan_linked_paths(plan),
        )
        logger.info(
            "check ingestion: CI regenerate plan=%s status=%s",
            plan_id,
            str(result.get("status") or ""),
        )
    except Exception as exc:  # noqa: BLE001 — best-effort follow-up
        logger.warning(
            "check ingestion: CI regenerate failed plan=%s: %s",
            str(plan.get("id") or ""),
            redact_all(str(exc)),
        )


# ── Org-scoped routes ───────────────────────────────────────────────


@org_router.post("/github/installations/claim", response_model=InstallationOut)
async def claim_github_installation(
    request: Request,
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
    org: dict = Depends(require_org_permission_dep("integrations:write")),
    installation_id: int | None = Query(
        None,
        description="Fallback when the JSON body is missing (proxy edge cases).",
        gt=0,
    ),
) -> InstallationOut:
    """Persist a GitHub App installation after the portal callback.

    ``GITHUB_APP_CALLBACK_URL`` points at the portal
    (``/agents/connect``, with ``/onboarding/connect`` redirecting there),
    so GitHub redirects there with ``installation_id`` instead of hitting
    ``/integrations/github/callback``. This route lets the wizard register
    the installation in Eden's DB.

    Body is read raw (not via a required Pydantic body model) so a portal
    proxy bug that sent ``Content-Type: application/json, application/json``
    cannot 422 before we parse ``{"installation_id": …}``. Query string is
    accepted as a second source.
    """
    raw_id: object | None = installation_id
    try:
        body_bytes = await request.body()
        if body_bytes:
            parsed = json.loads(body_bytes.decode("utf-8"))
            # Tolerate accidental double-encoding from proxies.
            if isinstance(parsed, str):
                parsed = json.loads(parsed)
            if isinstance(parsed, dict) and parsed.get("installation_id") is not None:
                raw_id = parsed.get("installation_id")
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError):
        pass

    if raw_id is None:
        raise HTTPException(422, "installation_id is required")
    try:
        resolved_id = ClaimInstallationRequest(installation_id=raw_id).installation_id
    except Exception as exc:
        raise HTTPException(422, "installation_id must be a positive integer") from exc

    eden_org_id = await _eden_org_or_404(org_id)
    pg = await get_postgres_client()
    installation_id = resolved_id

    # Refuse claiming an installation already bound to a different Eden org.
    foreign = await pg.fetchrow(
        """
        SELECT org_id FROM org_github_installations
        WHERE installation_id = $1 AND org_id <> $2
        LIMIT 1
        """,
        installation_id,
        eden_org_id,
    )
    if foreign:
        raise HTTPException(
            409,
            "GitHub installation is already claimed by another organization.",
        )

    existing = await pg.fetchrow(
        """
        SELECT installation_id, github_account_login, github_account_type,
               installed_at, suspended_at
        FROM org_github_installations
        WHERE org_id = $1 AND installation_id = $2
        """,
        eden_org_id,
        installation_id,
    )
    if existing:
        row = dict(existing)
    else:
        try:
            oauth = GitHubOAuthClient()
            token = await oauth.installation_token(installation_id)
            repos = await oauth.list_installation_repos(token)
            account_login = repos[0].owner if repos else "unknown"
        except (GitHubConfigError, GitHubAPIError) as exc:
            raise HTTPException(
                400,
                f"Could not verify GitHub installation: {exc}",
            ) from exc

        installer_id = await resolve_eden_user_id(user.get("user_id"))
        row = await _persist_installation_row(
            pg,
            org_id=eden_org_id,
            installation_id=installation_id,
            account_login=account_login,
            installed_by_user_id=installer_id,
        )

    return InstallationOut(
        installation_id=int(row["installation_id"]),
        account_login=row["github_account_login"],
        account_type=row["github_account_type"],
        installed_at=_installed_at_iso(row["installed_at"]),
        suspended=bool(row["suspended_at"]),
    )


@org_router.get("/github/installations", response_model=list[InstallationOut])
async def list_org_installations(
    org_id: str = Depends(require_path_org_access),
    org: dict = Depends(require_org_member),
) -> list[InstallationOut]:
    eden_org_id = str(org["org_id"])
    pg = await get_postgres_client()
    rows = await pg.fetch(
        """
        SELECT installation_id, github_account_login, github_account_type,
               installed_at, suspended_at
        FROM org_github_installations
        WHERE org_id = $1
        ORDER BY installed_at DESC
        """,
        eden_org_id,
    )
    return [
        InstallationOut(
            installation_id=int(r["installation_id"]),
            account_login=r["github_account_login"],
            account_type=r["github_account_type"],
            installed_at=_installed_at_iso(r["installed_at"]),
            suspended=bool(r["suspended_at"]),
        )
        for r in rows
    ]


@org_router.get("/github/connection", response_model=RepoConnectionOut | None)
async def get_org_github_connection(
    org_id: str = Depends(require_path_org_access),
    agent_id: str | None = Query(
        None,
        description="Agent id — returns that agent's linked repo (preferred).",
    ),
    _user: dict = Depends(get_current_user),
) -> RepoConnectionOut | None:
    """Return the active ``repo_connections`` row for this org/agent, or null.

    Members can read this so the Agents UI can show "PRs open on X"
    without requiring ``integrations:write``. Pass ``agent_id`` for
    per-agent linking (one repo per agent).
    """
    from eden.storage.postgres import get_postgres_client

    aid = (agent_id or "").strip() or None
    # Agents UI passes agent_id: only an agent-scoped link counts as
    # "Connected". Org-wide legacy rows still feed Improve PR fallbacks
    # via active_repo_connection(), but must not falsely mark every agent.
    pg = await get_postgres_client()
    if pg is None:
        return None
    try:
        if aid:
            row = await pg.fetchrow(
                """
                SELECT id, org_id, provider, installation_id, repo_full_name,
                       default_branch, status, agent_id
                FROM repo_connections
                WHERE org_id = $1
                  AND status = 'active'
                  AND agent_id = $2
                ORDER BY created_at DESC
                LIMIT 1
                """,
                org_id,
                aid,
            )
        else:
            from eden.providers.factory import active_repo_connection

            row = await active_repo_connection(org_id, agent_id=None)
    except Exception:
        return None
    if not row:
        return None
    conn = dict(row) if not isinstance(row, dict) else row
    repo = str(conn.get("repo_full_name") or "").strip()
    if not repo or "/" not in repo or "undefined" in repo.lower():
        return None
    return RepoConnectionOut(
        id=str(conn.get("id") or ""),
        org_id=str(conn.get("org_id") or org_id),
        provider=str(conn.get("provider") or "github"),
        installation_id=str(conn.get("installation_id") or ""),
        repo_full_name=repo,
        default_branch=str(conn.get("default_branch") or "").strip(),
        status=str(conn.get("status") or "active"),
        agent_id=(str(conn["agent_id"]) if conn.get("agent_id") else None),
    )


@org_router.get("/github/repos", response_model=list[RepoOut])
async def list_org_repos(
    org_id: str = Depends(require_path_org_access),
    org: dict = Depends(require_org_permission_dep("integrations:write")),
) -> list[RepoOut]:
    """List repos all the org's installations have access to.

    Admin-only (`integrations:write`). Member/viewer roles see the
    sidebar entry but the page tells them to ask an admin.
    """
    import asyncio
    import time as _time

    eden_org_id = str(org["org_id"])
    pg = await get_postgres_client()
    inst_rows = await pg.fetch(
        """
        SELECT installation_id FROM org_github_installations
        WHERE org_id = $1 AND suspended_at IS NULL
        """,
        eden_org_id,
    )

    async def _repos_for(installation_id: int) -> list[RepoOut]:
        now = _time.monotonic()
        cached = _repos_cache.get(installation_id)
        if cached is not None and cached[0] > now:
            return [
                RepoOut(
                    full_name=repo.full_name,
                    name=repo.name,
                    owner=repo.owner,
                    default_branch=repo.default_branch,
                    private=repo.private,
                    description=repo.description or "",
                    html_url=repo.html_url,
                    installation_id=installation_id,
                )
                for repo in cached[1]
            ]
        try:
            _, token = await _client_for(installation_id)
            repos = await GitHubOAuthClient().list_installation_repos(token)
        except (GitHubConfigError, GitHubAPIError) as exc:
            logger.warning(
                "list_org_repos installation %s: %s",
                installation_id,
                redact_all(str(exc)),
            )
            return []
        _repos_cache[installation_id] = (now + _REPOS_CACHE_TTL_S, repos)
        return [
            RepoOut(
                full_name=repo.full_name,
                name=repo.name,
                owner=repo.owner,
                default_branch=repo.default_branch,
                private=repo.private,
                description=repo.description or "",
                html_url=repo.html_url,
                installation_id=installation_id,
            )
            for repo in repos
        ]

    results = await asyncio.gather(*[_repos_for(int(r["installation_id"])) for r in inst_rows])
    out: list[RepoOut] = []
    for batch in results:
        out.extend(batch)
    return out


@org_router.post("/github/repos/connect", response_model=RepoConnectionOut)
async def connect_org_repo(
    req: ConnectRepoRequest,
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
    org: dict = Depends(require_org_permission_dep("integrations:write")),
) -> RepoConnectionOut:
    """Upsert an active ``repo_connections`` row for the linked GitHub repo.

    Called from the portal Connect flow after the user picks a repo.
    Linking is per-agent when ``agent_id`` is set — other agents keep
    their own active repos. Approve / Improve resolve via agent_id.
    """
    eden_org_id = str(org["org_id"])
    pg = await get_postgres_client()
    installation_id = int(req.installation_id)
    repo_full_name = req.repo_full_name
    default_branch = (req.default_branch or "").strip()
    agent_id = (req.agent_id or "").strip() or None

    owned = await pg.fetchrow(
        """
        SELECT installation_id FROM org_github_installations
        WHERE org_id = $1
          AND installation_id = $2
          AND suspended_at IS NULL
        """,
        eden_org_id,
        installation_id,
    )
    if not owned:
        raise HTTPException(
            400,
            "GitHub installation is not registered for this organization "
            "(or is suspended). Claim the installation first.",
        )

    if not default_branch:
        try:
            _, installation_token = await _client_for(installation_id)
            repos = await GitHubOAuthClient().list_installation_repos(
                installation_token
            )
            match = next(
                (r for r in repos if r.full_name == repo_full_name),
                None,
            )
            if match is not None:
                default_branch = (match.default_branch or "").strip()
            if not default_branch:
                import httpx

                async with httpx.AsyncClient(timeout=15.0) as http:
                    r = await http.get(
                        f"https://api.github.com/repos/{repo_full_name}",
                        headers={
                            "Authorization": f"Bearer {installation_token.token}",
                            "Accept": "application/vnd.github+json",
                            "X-GitHub-Api-Version": "2022-11-28",
                        },
                    )
                if r.status_code == 200:
                    default_branch = str(r.json().get("default_branch") or "").strip()
        except Exception as exc:
            logger.warning(
                "connect_org_repo: resolve default_branch failed: %s",
                redact_all(str(exc)),
            )
            default_branch = ""
    if not default_branch:
        raise HTTPException(
            400,
            "Could not resolve the repo default branch. Pass default_branch "
            "explicitly or ensure the installation can read the repository.",
        )

    connected_by = await resolve_eden_user_id(user.get("user_id"))
    if not connected_by:
        connected_by = str(user.get("user_id") or "unknown")

    # Deactivate only this agent's other active links (or legacy org-wide
    # rows when agent_id is omitted) — never wipe other agents' repos.
    if agent_id:
        await pg.execute(
            """
            UPDATE repo_connections
            SET status = 'inactive'
            WHERE org_id = $1
              AND status = 'active'
              AND agent_id = $2
              AND repo_full_name <> $3
            """,
            eden_org_id,
            agent_id,
            repo_full_name,
        )
        existing = await pg.fetchrow(
            """
            SELECT id FROM repo_connections
            WHERE org_id = $1
              AND agent_id = $2
            ORDER BY
              CASE WHEN repo_full_name = $3 THEN 0 ELSE 1 END,
              created_at DESC
            LIMIT 1
            """,
            eden_org_id,
            agent_id,
            repo_full_name,
        )
    else:
        await pg.execute(
            """
            UPDATE repo_connections
            SET status = 'inactive'
            WHERE org_id = $1
              AND status = 'active'
              AND (agent_id IS NULL OR agent_id = '')
              AND repo_full_name <> $2
            """,
            eden_org_id,
            repo_full_name,
        )
        existing = await pg.fetchrow(
            """
            SELECT id FROM repo_connections
            WHERE org_id = $1
              AND repo_full_name = $2
              AND (agent_id IS NULL OR agent_id = '')
            LIMIT 1
            """,
            eden_org_id,
            repo_full_name,
        )

    if existing:
        row = await pg.fetchrow(
            """
            UPDATE repo_connections
            SET installation_id = $3,
                default_branch = $4,
                status = 'active',
                provider = 'github',
                connected_by_user_id = $5,
                connected_at = NOW(),
                last_synced_at = NOW(),
                agent_id = $6,
                repo_full_name = $7
            WHERE org_id = $1 AND id = $2
            RETURNING id, org_id, provider, installation_id,
                      repo_full_name, default_branch, status, agent_id
            """,
            eden_org_id,
            str(existing["id"]),
            str(installation_id),
            default_branch,
            connected_by,
            agent_id,
            repo_full_name,
        )
    else:
        conn_id = f"rc_{uuid.uuid4().hex[:12]}"
        row = await pg.fetchrow(
            """
            INSERT INTO repo_connections (
                id, org_id, provider, installation_id, repo_full_name,
                default_branch, status, connected_by_user_id,
                connected_at, last_synced_at, agent_id
            )
            VALUES (
                $1, $2, 'github', $3, $4, $5, 'active', $6, NOW(), NOW(), $7
            )
            RETURNING id, org_id, provider, installation_id,
                      repo_full_name, default_branch, status, agent_id
            """,
            conn_id,
            eden_org_id,
            str(installation_id),
            repo_full_name,
            default_branch,
            connected_by,
            agent_id,
        )

    if not row:
        raise HTTPException(500, "Failed to persist repo connection")

    return RepoConnectionOut(
        id=str(row["id"]),
        org_id=str(row["org_id"]),
        provider=str(row["provider"]),
        installation_id=str(row["installation_id"]),
        repo_full_name=str(row["repo_full_name"]),
        default_branch=str(row["default_branch"]),
        status=str(row["status"]),
        agent_id=(str(row["agent_id"]) if row.get("agent_id") else None),
    )


@org_router.post("/github/integrate")
async def integrate_repo(
    org_id: str = Depends(require_path_org_access),
    org: dict = Depends(require_org_permission_dep("integrations:write")),
) -> None:
    """Retired: auto-integration PRs are no longer opened.

    Install the SDK manually (onboarding overlay / docs). GitHub App
    install + repo listing remain available for Agents → Connect.
    """
    raise HTTPException(
        status_code=410,
        detail=(
            "GitHub auto-integrate PR is retired. "
            "Install the Eden SDK manually; use GitHub App install only to "
            "link repos for listing."
        ),
    )


@org_router.get("/onboarding/pr-runs", response_model=list[PRRunOut])
async def list_onboarding_pr_runs(
    org_id: str = Depends(require_path_org_access),
    limit: int = Query(50, ge=1, le=200),
    org: dict = Depends(require_org_member),
) -> list[PRRunOut]:
    eden_org_id = str(org["org_id"])
    pg = await get_postgres_client()
    rows = await pg.fetch(
        """
        SELECT * FROM onboarding_pr_runs
        WHERE org_id = $1
        ORDER BY created_at DESC
        LIMIT $2
        """,
        eden_org_id,
        limit,
    )
    return [_row_to_pr_run_out(dict(r)) for r in rows]


@org_router.get("/onboarding/state", response_model=OnboardingStateOut)
async def get_onboarding_state(
    org_id: str = Depends(require_path_org_access),
    org: dict = Depends(require_org_member),
) -> OnboardingStateOut:
    eden_org_id = str(org["org_id"])
    row = await _ensure_state_row(eden_org_id)
    return OnboardingStateOut(**_state_to_dict(row))


@org_router.post("/onboarding/state", response_model=OnboardingStateOut)
async def patch_onboarding_state(
    patch: OnboardingStatePatch,
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
    org: dict = Depends(require_org_member),
) -> OnboardingStateOut:
    eden_org_id = str(org["org_id"])
    pg = await get_postgres_client()
    existing = await _ensure_state_row(eden_org_id)
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
        eden_org_id,
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
                eden_org_id,
            )
        except Exception:
            logger.debug(
                "onboarding: current_step sync skipped for org=%s",
                eden_org_id,
                exc_info=True,
            )
    row = await pg.fetchrow(
        "SELECT * FROM onboarding_state WHERE org_id = $1",
        eden_org_id,
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
