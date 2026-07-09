"""GitHub App OAuth + REST client for the onboarding wizard.

We use a **GitHub App** (not a classic OAuth App) so the org-level
"connect repo" flow gets:

* Fine-grained, per-repo permissions (Contents R/W + Pull requests
  R/W is enough for the integration PR).
* Short-lived installation tokens (1 h) instead of long-lived user
  tokens.
* Webhook delivery on `installation` + `pull_request` events so we
  can react to "install completed", "PR merged", "PR closed".

The flow is:

1. Owner/admin clicks "Connect GitHub" → backend redirects to
   `https://github.com/apps/<APP_SLUG>/installations/new?state=<csrf>`.
2. User picks the org + repos, GitHub redirects to our
   `/integrations/github/callback?installation_id=…&setup_action=…&state=…`.
3. Backend verifies the state, persists `(org_id, installation_id)` to
   `org_github_installations`, redirects to the wizard's "Choose repo"
   step.
4. From there, every API call mints a fresh installation token via
   :meth:`GitHubOAuthClient.installation_token` and uses it for REST
   calls.

All four GitHub App env vars (`GITHUB_APP_ID`,
`GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`,
`GITHUB_APP_PRIVATE_KEY`) are optional — when any is missing,
:func:`is_configured` returns False and the wizard's "Connect GitHub"
step gracefully degrades to a "Skip — integrate manually" path. This
matters for self-hosted Eden instances that don't have a GitHub App
configured.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import secrets
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

import httpx

from eden.config import get_settings

# Module-level singleton httpx client (mirrors the F42 pattern in
# ``eden.providers.pr``). Each ``async with httpx.AsyncClient(...)``
# opens a fresh client and discards keep-alive sockets at scope exit;
# the singleton keeps the TCP pool warm across the 4 GitHub App API
# calls per OAuth round-trip.
_HTTPX: httpx.AsyncClient | None = None


def _shared_httpx() -> httpx.AsyncClient:
    global _HTTPX
    if _HTTPX is None:
        _HTTPX = httpx.AsyncClient(timeout=30.0)
    return _HTTPX

logger = logging.getLogger(__name__)

# GitHub REST + JWT constants. Pinned here so the rest of the module
# never magic-strings them.
GITHUB_API_BASE = "https://api.github.com"
GITHUB_INSTALLATION_BASE = "https://github.com/apps"
GITHUB_AUTH_BASE = "https://github.com/login/oauth"
JWT_ALG = "RS256"
JWT_EXP_SECONDS = 600  # GitHub caps app JWTs at 10 minutes


@dataclass(frozen=True)
class InstallationToken:
    """Short-lived (~1h) token scoped to a single GitHub App installation."""

    token: str
    expires_at: int  # Unix timestamp
    installation_id: int

    @property
    def expired(self) -> bool:
        # Refresh 60s before the official expiry to absorb clock skew.
        return time.time() >= (self.expires_at - 60)


@dataclass(frozen=True)
class InstallationRepo:
    """One repo a user has granted the Eden App access to."""

    full_name: str           # e.g. "acme/agent-runner"
    name: str                # e.g. "agent-runner"
    owner: str               # e.g. "acme"
    default_branch: str
    private: bool
    description: str         # may be empty
    html_url: str
    pushed_at: str           # ISO-8601, may be empty


def is_configured() -> bool:
    """True iff a real GitHub App is wired up on this Eden instance.

    The wizard's "Connect GitHub" step uses this to decide whether to
    show the connect flow or fall back to a "Skip" path with a manual
    integration snippet.
    """
    s = get_settings()
    return all([
        getattr(s, "github_app_id", "").strip(),
        getattr(s, "github_app_client_id", "").strip(),
        getattr(s, "github_app_client_secret", "").strip(),
        getattr(s, "github_app_private_key", "").strip(),
    ])


class GitHubConfigError(RuntimeError):
    """Raised when an OAuth call lands on an unconfigured Eden instance."""


class GitHubAPIError(RuntimeError):
    """Raised when GitHub returns a non-2xx response."""

    def __init__(self, status_code: int, message: str, response_body: str = "") -> None:
        super().__init__(f"GitHub API {status_code}: {message}")
        self.status_code = status_code
        self.message = message
        self.response_body = response_body


class GitHubOAuthClient:
    """Thin wrapper around the four GitHub App endpoints we use.

    Stateless — does not cache installation tokens. Persist them via
    ``OrgGitHubInstallationStore`` in the routes layer (where they
    can be tied to org_id + the user that installed).
    """

    def __init__(
        self,
        *,
        app_id: str | None = None,
        client_id: str | None = None,
        client_secret: str | None = None,
        private_key: str | None = None,
        callback_url: str | None = None,
    ) -> None:
        s = get_settings()
        self.app_id = app_id or getattr(s, "github_app_id", "")
        self.client_id = client_id or getattr(s, "github_app_client_id", "")
        self.client_secret = client_secret or getattr(s, "github_app_client_secret", "")
        self.private_key = private_key or getattr(s, "github_app_private_key", "")
        self.callback_url = callback_url or getattr(s, "github_app_callback_url", "")

        if not is_configured():
            raise GitHubConfigError(
                "GitHub App is not configured. Set GITHUB_APP_ID, "
                "GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, and "
                "GITHUB_APP_PRIVATE_KEY in the environment."
            )

    # ----------- authorize URL ---------------------------------------

    def get_install_url(self, *, state: str) -> str:
        """Return the URL to send the user to so they can install the
        Eden GitHub App on their org + pick which repos to grant.

        ``state`` is the CSRF token the caller should generate via
        :func:`new_state_token` and persist on the session.
        """
        # GitHub App installation URLs use the app slug, but the
        # canonical "install on a new account" link is the public
        # `/apps/{slug}/installations/new` URL. Apps can also be
        # installed via the OAuth flow if the App is marked
        # "Request user authorization during installation".
        app_slug = self.client_id  # GitHub Apps publish via slug, not app_id
        params = {
            "state": state,
            "redirect_uri": self.callback_url,
        }
        return f"{GITHUB_INSTALLATION_BASE}/{app_slug}/installations/new?{urlencode(params)}"

    @staticmethod
    def new_state_token() -> str:
        """Generate a 32-byte URL-safe CSRF token.

        The wizard signs the user's `org_id` into the cookie at
        request time and verifies it matches on the callback. Don't
        accept a state token that wasn't issued by us.
        """
        return secrets.token_urlsafe(32)

    # ----------- exchange code + installation token ------------------

    async def exchange_code(self, code: str) -> str:
        """Exchange an OAuth code for a user-level access token.

        Only used when the App is set to "Request user authorization
        during installation". The user token is short-lived and is
        used purely to list which installations the user is a member
        of (so we can disambiguate when one user has installed Eden
        on multiple GitHub orgs).
        """
        async with _shared_httpx() as client:
            r = await client.post(
                f"{GITHUB_AUTH_BASE}/access_token",
                data={
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                    "code": code,
                },
                headers={"Accept": "application/json"},
            )
            if r.status_code != 200:
                raise GitHubAPIError(r.status_code, "code exchange failed", r.text)
            payload = r.json()
            if "error" in payload:
                raise GitHubAPIError(
                    400,
                    payload.get("error_description") or payload["error"],
                    r.text,
                )
            return payload["access_token"]

    def _app_jwt(self) -> str:
        """Sign a short-lived (10-min) JWT identifying the Eden App.

        Used as a Bearer for `/app/installations/*/access_tokens`. We
        implement JWT directly rather than pull a third-party lib;
        the GitHub-specified payload is two claims + a signature.
        """
        try:
            from cryptography.hazmat.backends import default_backend
            from cryptography.hazmat.primitives import hashes, serialization
            from cryptography.hazmat.primitives.asymmetric import padding
        except ImportError as exc:  # pragma: no cover - dep is in pyproject
            raise RuntimeError(
                "cryptography is required for GitHub App auth. "
                "Add `cryptography` to pyproject.toml."
            ) from exc

        now = int(time.time())
        header = _b64url(b'{"alg":"RS256","typ":"JWT"}')
        payload_dict = {
            # iat is 60s in the past to absorb clock skew between Eden + GitHub
            "iat": now - 60,
            "exp": now + JWT_EXP_SECONDS,
            "iss": self.app_id,
        }
        import json as _json
        payload = _b64url(_json.dumps(payload_dict, separators=(",", ":")).encode())
        signing_input = f"{header}.{payload}".encode()

        key = serialization.load_pem_private_key(
            self.private_key.encode(),
            password=None,
            backend=default_backend(),
        )
        signature = key.sign(
            signing_input,
            padding.PKCS1v15(),
            hashes.SHA256(),
        )
        return f"{header}.{payload}.{_b64url(signature)}"

    async def installation_token(self, installation_id: int) -> InstallationToken:
        """Mint a fresh installation access token (good for ~1 h).

        Cheap call (~150 ms); the routes layer should cache the result
        in-memory keyed on `installation_id` and refresh when
        :attr:`InstallationToken.expired` is True.
        """
        async with _shared_httpx() as client:
            r = await client.post(
                f"{GITHUB_API_BASE}/app/installations/{installation_id}/access_tokens",
                headers={
                    "Accept": "application/vnd.github+json",
                    "Authorization": f"Bearer {self._app_jwt()}",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            )
            if r.status_code not in (200, 201):
                raise GitHubAPIError(r.status_code, "installation_token", r.text)
            body = r.json()
            # Returned `expires_at` is ISO-8601; convert to epoch.
            import datetime as _dt
            exp_iso = body["expires_at"].replace("Z", "+00:00")
            expires_at = int(_dt.datetime.fromisoformat(exp_iso).timestamp())
            return InstallationToken(
                token=body["token"],
                expires_at=expires_at,
                installation_id=installation_id,
            )

    # ----------- list installations + repos --------------------------

    async def list_user_installations(self, user_token: str) -> list[dict[str, Any]]:
        """List GitHub installations the user has access to.

        Used when a single user has installed Eden on multiple GitHub
        accounts; the wizard's "Choose org" step disambiguates.
        """
        async with _shared_httpx() as client:
            r = await client.get(
                f"{GITHUB_API_BASE}/user/installations",
                headers={
                    "Accept": "application/vnd.github+json",
                    "Authorization": f"token {user_token}",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            )
            if r.status_code != 200:
                raise GitHubAPIError(r.status_code, "list_user_installations", r.text)
            return r.json().get("installations", [])

    async def list_installation_repos(
        self,
        installation_token: InstallationToken,
    ) -> list[InstallationRepo]:
        """List the repos this installation has access to.

        Paginates internally; caps at 5 pages × 100 repos = 500 repos
        (the wizard renders them in a single dropdown; nobody scrolls
        500 items).
        """
        repos: list[InstallationRepo] = []
        async with _shared_httpx() as client:
            for page in range(1, 6):
                r = await client.get(
                    f"{GITHUB_API_BASE}/installation/repositories",
                    headers={
                        "Accept": "application/vnd.github+json",
                        "Authorization": f"token {installation_token.token}",
                        "X-GitHub-Api-Version": "2022-11-28",
                    },
                    params={"per_page": 100, "page": page},
                )
                if r.status_code != 200:
                    raise GitHubAPIError(r.status_code, "list_installation_repos", r.text)
                page_repos = r.json().get("repositories", [])
                if not page_repos:
                    break
                for item in page_repos:
                    repos.append(InstallationRepo(
                        full_name=item["full_name"],
                        name=item["name"],
                        owner=item["owner"]["login"],
                        default_branch=item.get("default_branch", "main"),
                        private=item.get("private", True),
                        description=item.get("description") or "",
                        html_url=item.get("html_url", ""),
                        pushed_at=item.get("pushed_at") or "",
                    ))
                if len(page_repos) < 100:
                    break
        return repos


# ─── Webhook signature verification ─────────────────────────────────


def verify_webhook_signature(*, body: bytes, signature_header: str, secret: str) -> bool:
    """Verify the `X-Hub-Signature-256` header on a GitHub webhook.

    Constant-time compare; rejects malformed headers.
    """
    if not signature_header or not signature_header.startswith("sha256="):
        return False
    expected = "sha256=" + hmac.new(
        secret.encode("utf-8"),
        body,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, signature_header)


# ─── Internal helpers ───────────────────────────────────────────────


def _b64url(data: bytes) -> str:
    """URL-safe base64 without padding (per JWT spec, RFC 7515 §3)."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


__all__ = [
    "GITHUB_API_BASE",
    "GitHubAPIError",
    "GitHubConfigError",
    "GitHubOAuthClient",
    "InstallationRepo",
    "InstallationToken",
    "is_configured",
    "verify_webhook_signature",
]
